import type {
  BudgetCaps,
  CheckResult,
  ConditionKind,
  HarnessEvent,
  ModelReport,
  UsageReport,
} from "./types.js";

// Run manifest: the immutable record of one run, written when the run
// finishes. The manifest is the run's private full record — it may
// reference local paths and session summaries (claims). The sanitized
// export is a separate, allowlist-built projection of the manifest and
// the event log; see buildExport.

export interface SessionRecord {
  role: string;
  stepIndex: number;
  status: "completed" | "failed" | "timeout";
  /** Adapter-supplied summary. A claim, not outcome evidence. */
  claimSummary: string;
}

export interface RunManifest {
  manifestVersion: 1;
  experimentId: string;
  runId: string;
  scenarioSlug: string;
  scenarioVersion: string;
  variantId: string;
  condition: ConditionKind;
  runtimeId: string;
  adapter: string;
  seed: number;
  planPosition: number;
  conditionOrder: ConditionKind[];
  startedAt: string;
  endedAt: string;
  wallTimeSeconds: number;
  model: ModelReport;
  harnessVersion: string;
  tools: string[];
  hardware: string;
  budget: BudgetCaps;
  budgetBreaches: string[];
  stopRule: string;
  outcome: {
    status: "passed" | "failed" | "error";
    /** Weighted mean of check scores, 0..1. */
    score: number;
    checks: CheckResult[];
  };
  metrics: {
    /** Distinct injected changes whose adoption check failed. */
    missedChanges: number;
    missedChangeInjections: string[];
    reworkEvents: number;
    /** Operator-logged human interventions (count only). */
    interventions: number;
    interventionsSource: "operator-file" | "none";
  };
  usage: UsageReport;
  failureCategory: string | null;
  artifacts: string[];
  privacyClassification: string;
  sessions: SessionRecord[];
}

export interface SanitizedExport {
  exportVersion: 1;
  experimentId: string;
  runId: string;
  scenario: { slug: string; version: string };
  variantId: string;
  condition: ConditionKind;
  adapter: string;
  seed: number;
  conditionOrder: ConditionKind[];
  startedAt: string;
  endedAt: string;
  wallTimeSeconds: number;
  configuration: {
    roles: string[];
    budget: BudgetCaps;
    stopRule: string;
    moonboothApiBaseUrl?: string;
  };
  outcome: {
    status: "passed" | "failed" | "error";
    score: number;
    checks: { id: string; passed: boolean; score: number }[];
  };
  metrics: {
    missedChanges: number;
    missedChangeInjections: string[];
    reworkEvents: number;
    interventions: number;
  };
  usage: UsageReport;
  model: ModelReport;
  eventTimeline: { t: string; kind: string; summary: string }[];
  sourceReferences: string[];
  knownLimitations: string[];
  privacyClassification: string;
}

// The export is built field-by-field from an allowlist. There is no
// field for workspace contents, file contents, credentials, booth
// identifiers, or bearer URLs, so none can leak through it. As defense
// in depth, assertExportSafe scans the serialized export for
// credential-shaped strings and refuses to emit it if any appear.

const CREDENTIAL_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}/,
  /\b(?:sk|ghp|gho|npm|xox[baprs])[-_][A-Za-z0-9]{8,}/,
  /["']?(?:credential|secret|password|api[_-]?key)["']?\s*[:=]\s*["'][^"']{4,}["']/i,
  /[?&](?:credential|token|secret|key)=[^&\s"']+/i,
  /\/booths\/[A-Za-z0-9_-]{6,}/,
];

export function assertExportSafe(exportObj: unknown): void {
  const serialized = JSON.stringify(exportObj);
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(
        `Sanitized export refused: content matches credential pattern ${pattern}. ` +
          `The export builder is allowlist-based; this indicates a bug, not data to redact silently.`,
      );
    }
  }
}

function summarizeEvent(event: HarnessEvent): string {
  const d = event.detail ?? {};
  const role = typeof d.role === "string" ? d.role : event.role;
  switch (event.kind) {
    case "run_started":
      return `Run started (condition ${String(d.condition ?? "")}, variant ${String(d.variant ?? "")}).`;
    case "channel_ready":
      return "Coordination channel set up and seeded from the fixture.";
    case "session_started":
      return `Session started for role ${role ?? "?"}, step ${String(d.stepIndex ?? "?")}.`;
    case "session_finished":
      return `Session for role ${role ?? "?"} finished with status ${String(d.status ?? "?")}.`;
    case "sync_in":
      return `Role ${role ?? "?"} pulled shared state (${String(d.changed ?? 0)} file(s) updated).`;
    case "sync_out":
      return `Role ${role ?? "?"} published ${String(d.published ?? 0)} file(s); ${String(d.rework ?? 0)} rework event(s).`;
    case "injection_applied":
      return `Driver injected change ${String(d.injectionId ?? "?")}.`;
    case "checks_finished":
      return `Outcome checks finished: score ${String(d.score ?? "?")}, status ${String(d.status ?? "?")}.`;
    case "budget_breach":
      return `Budget breach recorded: ${String(d.cap ?? "cap")}.`;
    case "run_finished":
      return `Run finished with outcome ${String(d.status ?? "?")}.`;
    default:
      return `Event ${event.kind}.`;
  }
}

export function buildExport(args: {
  manifest: RunManifest;
  events: HarnessEvent[];
  scenarioLimitations: string[];
  adapterLimitations: string[];
  moonboothApiBaseUrl?: string;
  harnessVersion: string;
}): SanitizedExport {
  const m = args.manifest;
  const exportObj: SanitizedExport = {
    exportVersion: 1,
    experimentId: m.experimentId,
    runId: m.runId,
    scenario: { slug: m.scenarioSlug, version: m.scenarioVersion },
    variantId: m.variantId,
    condition: m.condition,
    adapter: m.adapter,
    seed: m.seed,
    conditionOrder: m.conditionOrder,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    wallTimeSeconds: m.wallTimeSeconds,
    configuration: {
      roles: m.sessions.map((s) => s.role),
      budget: m.budget,
      stopRule: m.stopRule,
      ...(m.condition === "moonbooth" && args.moonboothApiBaseUrl
        ? { moonboothApiBaseUrl: args.moonboothApiBaseUrl }
        : {}),
    },
    outcome: {
      status: m.outcome.status,
      score: m.outcome.score,
      checks: m.outcome.checks.map((c) => ({ id: c.id, passed: c.passed, score: c.score })),
    },
    metrics: {
      missedChanges: m.metrics.missedChanges,
      missedChangeInjections: m.metrics.missedChangeInjections,
      reworkEvents: m.metrics.reworkEvents,
      interventions: m.metrics.interventions,
    },
    usage: m.usage,
    model: m.model,
    eventTimeline: args.events.map((e) => ({
      t: e.t,
      kind: e.kind,
      summary: summarizeEvent(e),
    })),
    sourceReferences: [
      `scenario:${m.scenarioSlug}@${m.scenarioVersion}`,
      `harness:@moonbooth/labs@${args.harnessVersion}`,
      `manifest:${m.runId}`,
    ],
    knownLimitations: [...args.scenarioLimitations, ...args.adapterLimitations],
    privacyClassification: m.privacyClassification,
  };
  assertExportSafe(exportObj);
  return exportObj;
}
