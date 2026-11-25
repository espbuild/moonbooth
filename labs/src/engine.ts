import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type {
  AdapterKind,
  ConditionKind,
  HarnessEvent,
  ModelReport,
  RuntimeDef,
  ScenarioConfig,
  SessionResult,
  UsageReport,
  VariantDef,
} from "./types.js";
import { NOT_REPORTED } from "./types.js";
import { conditionOrder, normalizeSeed } from "./rng.js";
import { AdapterUnavailableError, createAdapter } from "./adapters/adapter.js";
import { createChannel } from "./conditions/index.js";
import { readContractDir } from "./conditions/condition.js";
import { assembleMergedWorkspace, runChecks } from "./checks.js";
import { buildExport, type RunManifest, type SessionRecord } from "./manifest.js";

const exec = promisify(execFile);

export const LABS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function harnessVersion(): Promise<string> {
  try {
    const raw = await readFile(path.join(LABS_ROOT, "package.json"), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export interface EngineOptions {
  runsDir: string;
  seed: number | string;
  /** Force every run to this adapter (the CLI's --adapter / --dry-run). */
  adapterOverride?: AdapterKind;
  /** Restrict the campaign to these conditions. */
  conditionsOverride?: ConditionKind[];
  /** Override the scenario's per-run wall-time cap, in seconds. */
  budgetCapSeconds?: number;
  /** Operator-logged interventions file (JSON array). Count only is used. */
  interventionsFile?: string;
  /** Test hook: point the moonbooth condition at a local API double. */
  moonboothApiBaseUrl?: string;
}

export interface PlannedRun {
  variant: VariantDef;
  variantIndex: number;
  condition: ConditionKind;
  planPosition: number;
  conditionOrder: ConditionKind[];
  runId: string;
}

/** Plan a campaign: every variant under every condition, counterbalanced. */
export function planRuns(
  scenario: ScenarioConfig,
  opts: EngineOptions,
): PlannedRun[] {
  const conditions = opts.conditionsOverride ?? scenario.conditions;
  const seed = normalizeSeed(opts.seed);
  const planned: PlannedRun[] = [];
  let position = 0;
  scenario.variants.forEach((variant, variantIndex) => {
    const order = conditionOrder(conditions, variantIndex, seed);
    for (const condition of order) {
      planned.push({
        variant,
        variantIndex,
        condition,
        planPosition: position,
        conditionOrder: order,
        runId: `${scenario.id}-${variant.id}-${condition}-s${seed}-p${position}`,
      });
      position++;
    }
  });
  return planned;
}

function pickRuntime(scenario: ScenarioConfig, opts: EngineOptions): RuntimeDef {
  if (opts.adapterOverride) {
    const match = scenario.runtimes.find((r) => r.adapter === opts.adapterOverride);
    if (match) return match;
    return { id: `${opts.adapterOverride}-override`, adapter: opts.adapterOverride };
  }
  return scenario.runtimes[0];
}

const ADAPTER_LIMITATIONS: Record<string, string[]> = {
  stub: [
    "Sessions were performed by the deterministic stub adapter (scripted file operations, not model behavior). The run exercises the harness pipeline; it is not evidence about any model, runtime, or condition's effectiveness.",
  ],
  codex: [
    "Token usage is recorded only when the Codex CLI event stream reports it. The CLI does not report dollar cost, so cost is 'not reported' and is never estimated from tokens.",
  ],
  "api-session": [
    "API sessions are single-turn with no tool loop in this harness version; cost is 'not reported' because the harness keeps no price table.",
  ],
};

function aggregateUsage(sessions: SessionResult[]): UsageReport {
  const sum = (pick: (u: UsageReport) => number | "not reported") => {
    let total: number | null = null;
    for (const s of sessions) {
      const v = pick(s.usage);
      if (typeof v === "number") total = (total ?? 0) + v;
    }
    return total ?? NOT_REPORTED;
  };
  const costUsd = sum((u) => u.costUsd);
  return {
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    costUsd,
    costMethod: costUsd === NOT_REPORTED ? "not reported" : "adapter-reported",
  };
}

function hardwareNote(): string {
  const cpu = os.cpus()[0]?.model ?? "unknown cpu";
  const gib = Math.round(os.totalmem() / 2 ** 30);
  return `${os.platform()} ${os.arch()}, ${cpu}, ${gib} GiB RAM`;
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  manifest: RunManifest;
}

export async function executeRun(
  scenario: ScenarioConfig,
  planned: PlannedRun,
  opts: EngineOptions,
): Promise<RunOutcome> {
  const version = await harnessVersion();
  const runtime = pickRuntime(scenario, opts);
  const adapter = createAdapter(runtime);
  const runDir = path.join(opts.runsDir, scenario.id, planned.runId);
  await mkdir(path.dirname(runDir), { recursive: true });
  await mkdir(runDir, { recursive: false }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "EEXIST") {
      throw new Error(
        `Run directory already exists: ${runDir}. Run manifests are immutable; choose a different seed or remove the old run directory deliberately.`,
      );
    }
    throw err;
  });

  const events: HarnessEvent[] = [];
  const eventsPath = path.join(runDir, "events.jsonl");
  const record = (kind: string, detail?: Record<string, unknown>, role?: string) => {
    const event: HarnessEvent = {
      t: new Date().toISOString(),
      kind,
      runId: planned.runId,
      ...(role ? { role } : {}),
      ...(detail ? { detail } : {}),
    };
    events.push(event);
    void appendFile(eventsPath, JSON.stringify(event) + "\n", "utf8");
  };

  const startedAt = new Date();
  const startedMs = Date.now();
  const wallCap =
    opts.budgetCapSeconds ?? scenario.budget.maxWallTimeSecondsPerRun;
  const budget = { ...scenario.budget, maxWallTimeSecondsPerRun: wallCap };
  const budgetBreaches: string[] = [];
  const sessions: SessionRecord[] = [];
  const sessionResults: SessionResult[] = [];
  let failureCategory: string | null = null;
  let reworkEvents = 0;
  let aborted = false;

  record("run_started", {
    condition: planned.condition,
    variant: planned.variant.id,
    adapter: runtime.adapter,
    seed: normalizeSeed(opts.seed),
  });

  const fixtureDir = path.join(LABS_ROOT, planned.variant.fixture);
  const rolesById = new Map(scenario.roles.map((r) => [r.id, r]));
  const workspaces = new Map<string, string>();
  for (const step of planned.variant.steps) {
    if (!workspaces.has(step.role)) {
      const ws = path.join(runDir, "workspaces", step.role);
      await cp(fixtureDir, ws, { recursive: true });
      workspaces.set(step.role, ws);
    }
  }

  const channel = createChannel(
    planned.condition,
    runDir,
    scenario,
    opts.moonboothApiBaseUrl,
  );
  await channel.setup();
  const fixtureContract = await readContractDir(fixtureDir);
  await channel.seed(fixtureContract);
  for (const role of workspaces.keys()) {
    channel.noteWorkspaceSeeded(role, fixtureContract);
  }
  record("channel_ready", { condition: planned.condition });

  const injectionsByStep = new Map<number, typeof scenario.injections>();
  for (const inj of scenario.injections) {
    const list = injectionsByStep.get(inj.beforeStepIndex) ?? [];
    list.push(inj);
    injectionsByStep.set(inj.beforeStepIndex, list);
  }
  const appliedInjections = new Set<string>();
  const applyInjections = async (stepIndex: number) => {
    for (const inj of injectionsByStep.get(stepIndex) ?? []) {
      await channel.applyInjection(inj);
      appliedInjections.add(inj.id);
      record("injection_applied", { injectionId: inj.id, beforeStepIndex: stepIndex });
    }
  };

  for (let stepIndex = 0; stepIndex < planned.variant.steps.length; stepIndex++) {
    if (aborted) break;
    await applyInjections(stepIndex);
    const step = planned.variant.steps[stepIndex];
    const role = rolesById.get(step.role)!;
    const workspace = workspaces.get(step.role)!;

    if (step.syncIn !== false) {
      const { changed } = await channel.syncIn(step.role, workspace);
      record("sync_in", { changed: changed.length, stepIndex }, step.role);
    }

    const elapsed = (Date.now() - startedMs) / 1000;
    const remaining = Math.max(1, Math.floor(wallCap - elapsed));
    record("session_started", { stepIndex }, step.role);
    let result: SessionResult;
    try {
      result = await adapter.runSession({
        runId: planned.runId,
        role,
        stepIndex,
        workspace,
        brief: [role.brief, step.brief].filter(Boolean).join("\n\n"),
        timeoutSeconds: remaining,
        runtime,
        script: step.script,
        record: (kind, detail) => record(kind, detail, step.role),
      });
    } catch (err) {
      if (err instanceof AdapterUnavailableError) {
        failureCategory = "adapter_unavailable";
        record("adapter_unavailable", { message: err.message }, step.role);
        aborted = true;
        sessions.push({
          role: step.role,
          stepIndex,
          status: "failed",
          claimSummary: err.message,
        });
        break;
      }
      throw err;
    }
    sessionResults.push(result);
    sessions.push({
      role: step.role,
      stepIndex,
      status: result.status,
      claimSummary: result.summary,
    });
    record(
      "session_finished",
      { status: result.status, stepIndex },
      step.role,
    );
    if (result.status !== "completed" && !failureCategory) {
      failureCategory = result.failureCategory ?? "session_failed";
    }

    if (step.syncOut !== false) {
      const { published, rework } = await channel.syncOut(step.role, workspace);
      reworkEvents += rework.length;
      record(
        "sync_out",
        { published: published.length, rework: rework.length, stepIndex },
        step.role,
      );
    }

    if ((Date.now() - startedMs) / 1000 > wallCap) {
      budgetBreaches.push("maxWallTimeSecondsPerRun");
      record("budget_breach", { cap: "maxWallTimeSecondsPerRun" });
      if (!failureCategory) failureCategory = "budget_exceeded";
      aborted = true;
    }
  }
  // Injections scheduled at or beyond the final step still land before checks.
  for (const inj of scenario.injections) {
    if (!appliedInjections.has(inj.id)) await applyInjections(inj.beforeStepIndex);
  }

  // Operator-logged interventions: count only; notes never enter any record.
  let interventions = 0;
  let interventionsSource: "operator-file" | "none" = "none";
  const interventionsPath =
    opts.interventionsFile ?? path.join(runDir, "interventions.json");
  const interventionsRaw = await readFile(interventionsPath, "utf8").catch(() => null);
  if (interventionsRaw !== null) {
    try {
      const parsed = JSON.parse(interventionsRaw) as unknown;
      if (Array.isArray(parsed)) {
        interventions = parsed.length;
        interventionsSource = "operator-file";
      }
    } catch {
      // A malformed interventions file counts as none; the run record
      // says so via interventionsSource.
    }
  }
  if (interventions > scenario.budget.maxInterventionsPerRun) {
    budgetBreaches.push("maxInterventionsPerRun");
    record("budget_breach", { cap: "maxInterventionsPerRun" });
  }

  // Outcome evaluation against the merged workspace.
  const mergedDir = path.join(runDir, "merged");
  // Pull the channel's final state into a scratch workspace and read
  // what landed; assembleMergedWorkspace writes it over the fixture.
  const scratchDir = path.join(runDir, ".evaluation");
  await channel.syncIn("evaluation", scratchDir);
  const channelState = await readContractDir(scratchDir);
  await assembleMergedWorkspace({
    fixtureDir,
    roles: scenario.roles,
    workspaces,
    channelState,
    dest: mergedDir,
  });
  const checks = aborted && failureCategory === "adapter_unavailable" ? [] : await runChecks(scenario.checks, mergedDir);
  const totalWeight = checks.reduce((acc, c) => acc + c.weight, 0);
  const score =
    totalWeight > 0
      ? checks.reduce((acc, c) => acc + c.score * c.weight, 0) / totalWeight
      : 0;
  const outcomeStatus: RunManifest["outcome"]["status"] =
    aborted && failureCategory === "adapter_unavailable"
      ? "error"
      : checks.every((c) => c.passed)
        ? "passed"
        : "failed";
  record("checks_finished", { score, status: outcomeStatus });

  const missed = new Set<string>();
  for (const c of checks) {
    if (c.detectsMissedChange && !c.passed) missed.add(c.detectsMissedChange);
  }

  const usage = aggregateUsage(sessionResults);
  if (
    typeof usage.costUsd === "number" &&
    scenario.budget.maxCostUsdPerRun !== null &&
    usage.costUsd > scenario.budget.maxCostUsdPerRun
  ) {
    budgetBreaches.push("maxCostUsdPerRun");
    record("budget_breach", { cap: "maxCostUsdPerRun" });
  }

  const endedAt = new Date();
  const wallTimeSeconds = (Date.now() - startedMs) / 1000;
  const model: ModelReport =
    sessionResults.length > 0
      ? sessionResults[sessionResults.length - 1].model
      : adapter.describe();
  const tools = [`node ${process.version}`];
  if (planned.condition === "git") {
    const gv = await exec("git", ["--version"]).catch(() => null);
    if (gv) tools.push(gv.stdout.trim());
  }

  const manifest: RunManifest = {
    manifestVersion: 1,
    experimentId: scenario.id,
    runId: planned.runId,
    scenarioSlug: scenario.slug,
    scenarioVersion: scenario.version,
    variantId: planned.variant.id,
    condition: planned.condition,
    runtimeId: runtime.id,
    adapter: runtime.adapter,
    seed: normalizeSeed(opts.seed),
    planPosition: planned.planPosition,
    conditionOrder: planned.conditionOrder,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    wallTimeSeconds: Math.round(wallTimeSeconds * 1000) / 1000,
    model,
    harnessVersion: version,
    tools,
    hardware: hardwareNote(),
    budget,
    budgetBreaches,
    stopRule: scenario.stopRule,
    outcome: { status: outcomeStatus, score, checks },
    metrics: {
      missedChanges: missed.size,
      missedChangeInjections: [...missed],
      reworkEvents,
      interventions,
      interventionsSource,
    },
    usage,
    failureCategory,
    artifacts: ["manifest.json", "events.jsonl", "export.json", "merged/"],
    privacyClassification: "synthetic-fixture",
    sessions,
  };
  record("run_finished", { status: outcomeStatus });
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const exportObj = buildExport({
    manifest,
    events,
    scenarioLimitations: scenario.knownLimitations,
    adapterLimitations: ADAPTER_LIMITATIONS[runtime.adapter] ?? [],
    moonboothApiBaseUrl: opts.moonboothApiBaseUrl ?? scenario.moonbooth?.apiBaseUrl,
    harnessVersion: version,
  });
  await writeFile(path.join(runDir, "export.json"), JSON.stringify(exportObj, null, 2) + "\n", "utf8");

  await channel.teardown();
  return { runId: planned.runId, runDir, manifest };
}

/** Run a full campaign: every planned run in plan order. */
export async function runScenario(
  scenario: ScenarioConfig,
  opts: EngineOptions,
): Promise<RunOutcome[]> {
  const planned = planRuns(scenario, opts);
  const outcomes: RunOutcome[] = [];
  for (const run of planned) {
    outcomes.push(await executeRun(scenario, run, opts));
  }
  return outcomes;
}
