// The telephone game runner (MB-09): a chain of five seats, each
// restating a 12-requirement spec from the previous seat's handoff,
// scored by the deterministic drift scorer (./scorer.ts).
//
// This is the harness support the game needs that the build engine
// does not have: the build engine runs roles against a shared
// workspace and merges the result, while a game run is a chain —
// each seat's output is the next seat's only input. The runner is
// deliberately separate from runScenario; it shares the harness's
// conventions (immutable run directories under runs/<id>/<run-id>,
// a manifest per run, "not reported" never estimated) without
// bending the build engine's semantics.
//
// Conditions are handoff channels (gamebook arms B / C / D):
//   transcript        — one shared transcript document; each seat's
//                       restatement is appended as a block and the
//                       next seat reads the latest block.
//   moonbooth         — handoffs are structured requirement entries
//                       posted to a booth record. The dry run uses a
//                       local record double (the same pattern as the
//                       build harness's booth double in tests): no
//                       production booth is created.
//   moonbooth-ablated — the booth with structured requirement
//                       entries removed (the gamebook's ablation):
//                       handoffs are free-text events only, and the
//                       receiving seat re-parses the prose into
//                       entries, recovering ids by position.
//
// Only the stub adapter plays seats in this increment: canon
// requirement 3 is a stub dry run. The stub's behavior is scripted
// by the variant (restate exactly, or with scripted drop / distort /
// truncation), so condition arms differ in the form of the artifact
// handed off, not in scripted damage — the dry run proves plumbing,
// and its scripted outcomes are labeled expectations, never results.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckResult } from "../types.js";
import { normalizeSeed } from "../rng.js";
import { harnessVersion } from "../engine.js";
import { normalizeStatement, scoreChain, scoreProbeAnswer, type ChainScore } from "./scorer.js";
import {
  GAME_CONDITION_LETTERS,
  type GameConditionKind,
  type GameScenarioConfig,
  type RequirementEntry,
  type TelephoneStubOp,
} from "./types.js";

// ---------------------------------------------------------------------------
// Handoff channels

export interface PostedHandoff {
  seat: number;
  form: "transcript-entry" | "structured-entries" | "free-text-event";
  rendered: string;
}

export interface ChainChannel {
  readonly kind: GameConditionKind;
  readonly artifactName: string;
  seed(entries: RequirementEntry[]): void;
  post(seat: number, entries: RequirementEntry[]): PostedHandoff;
  /** What the next seat receives, parsed back into entries. */
  latest(): RequirementEntry[];
  handoffs(): PostedHandoff[];
  artifactText(): string;
}

function renderEntryBlock(label: string, entries: RequirementEntry[]): string {
  return [label, ...entries.map((e) => `${e.id}: ${e.statement}`)].join("\n");
}

function parseEntryBlock(block: string): RequirementEntry[] {
  return block
    .split("\n")
    .slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const idx = line.indexOf(": ");
      return { id: line.slice(0, idx), statement: line.slice(idx + 2) };
    });
}

class TranscriptChannel implements ChainChannel {
  readonly kind = "transcript" as const;
  readonly artifactName = "transcript.txt";
  private blocks: string[] = [];
  private posted: PostedHandoff[] = [];

  seed(entries: RequirementEntry[]): void {
    this.blocks.push(renderEntryBlock("Driver seed", entries));
  }
  post(seat: number, entries: RequirementEntry[]): PostedHandoff {
    const rendered = renderEntryBlock(`Seat ${seat} restatement`, entries);
    this.blocks.push(rendered);
    const handoff = { seat, form: "transcript-entry" as const, rendered };
    this.posted.push(handoff);
    return handoff;
  }
  latest(): RequirementEntry[] {
    return parseEntryBlock(this.blocks[this.blocks.length - 1]);
  }
  handoffs(): PostedHandoff[] {
    return this.posted;
  }
  artifactText(): string {
    return this.blocks.join("\n\n") + "\n";
  }
}

class BoothChannel implements ChainChannel {
  readonly kind = "moonbooth" as const;
  readonly artifactName = "booth-record.json";
  private record: { seat: number; entries: RequirementEntry[] }[] = [];
  private posted: PostedHandoff[] = [];

  seed(entries: RequirementEntry[]): void {
    this.record.push({ seat: 0, entries: entries.map((e) => ({ ...e })) });
  }
  post(seat: number, entries: RequirementEntry[]): PostedHandoff {
    const copy = entries.map((e) => ({ ...e }));
    this.record.push({ seat, entries: copy });
    const handoff = { seat, form: "structured-entries" as const, rendered: JSON.stringify(copy) };
    this.posted.push(handoff);
    return handoff;
  }
  latest(): RequirementEntry[] {
    return this.record[this.record.length - 1].entries.map((e) => ({ ...e }));
  }
  handoffs(): PostedHandoff[] {
    return this.posted;
  }
  artifactText(): string {
    return (
      JSON.stringify(
        { kind: "booth-record-double", note: "Local record double for the dry run; no production booth was created.", record: this.record },
        null,
        2,
      ) + "\n"
    );
  }
}

class AblatedBoothChannel implements ChainChannel {
  readonly kind = "moonbooth-ablated" as const;
  readonly artifactName = "booth-events.json";
  private events: { seat: number; text: string }[] = [];
  private lastIds: string[] = [];
  private posted: PostedHandoff[] = [];

  seed(entries: RequirementEntry[]): void {
    this.events.push({ seat: 0, text: renderProse(entries) });
    this.lastIds = entries.map((e) => e.id);
  }
  post(seat: number, entries: RequirementEntry[]): PostedHandoff {
    const text = renderProse(entries);
    this.events.push({ seat, text });
    this.lastIds = entries.map((e) => e.id);
    const handoff = { seat, form: "free-text-event" as const, rendered: text };
    this.posted.push(handoff);
    return handoff;
  }
  latest(): RequirementEntry[] {
    const text = this.events[this.events.length - 1].text;
    const statements = splitProse(text);
    return statements.map((statement, i) => ({
      id: this.lastIds[i] ?? `R${i + 1}`,
      statement,
    }));
  }
  handoffs(): PostedHandoff[] {
    return this.posted;
  }
  artifactText(): string {
    return (
      JSON.stringify(
        { kind: "booth-free-text-events", note: "Ablated booth: handoffs are free-text events only; structured requirement entries are removed.", events: this.events },
        null,
        2,
      ) + "\n"
    );
  }
}

/** Render entries as flowing prose: statements joined, ids dropped. */
export function renderProse(entries: RequirementEntry[]): string {
  return entries.map((e) => e.statement).join(" ");
}

/**
 * Split prose back into statements: a sentence boundary is a period
 * followed by a capitalized next sentence. Periods inside a statement
 * (the save@sortlater.example address in R9) are not followed by a
 * capital, so they do not split.
 */
export function splitProse(text: string): string[] {
  return text
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function createChainChannel(kind: GameConditionKind): ChainChannel {
  switch (kind) {
    case "transcript":
      return new TranscriptChannel();
    case "moonbooth":
      return new BoothChannel();
    case "moonbooth-ablated":
      return new AblatedBoothChannel();
  }
}

// ---------------------------------------------------------------------------
// Stub seat behavior

/**
 * The stub's deterministic distortion: the first number in the
 * statement is replaced with a wrong value — 7 when the number is
 * above 10 (so R4's "30 days" becomes "7 days", exactly as the
 * variant description states), otherwise the number plus one.
 */
export function distortStatement(statement: string): string {
  return statement.replace(/\d+(?:\.\d+)?/, (m) => {
    const n = Number(m);
    return String(n > 10 ? 7 : n + 1);
  });
}

function applyRestate(
  input: RequirementEntry[],
  op: Extract<TelephoneStubOp, { op: "restateSpec" }>,
): RequirementEntry[] {
  let out = input.map((e) => ({ ...e }));
  if (op.only) out = out.filter((e) => op.only!.includes(e.id));
  if (op.drop) out = out.filter((e) => !op.drop!.includes(e.id));
  if (op.distort) {
    out = out.map((e) =>
      op.distort!.includes(e.id) ? { ...e, statement: distortStatement(e.statement) } : e,
    );
  }
  return out;
}

/** Compose the probe answer from the spec exactly as the seat received it. */
export function composeProbeAnswer(input: RequirementEntry[]): string {
  const r7 = input.find((e) => e.id === "R7");
  if (!r7) {
    return "The spec as I received it does not say whether the digest ever lists tagged bookmarks first.";
  }
  const s = normalizeStatement(r7.statement);
  if (/untagged bookmarks before tagged/.test(s)) {
    return "No — the digest lists untagged bookmarks before tagged ones, so tagged bookmarks are never listed first.";
  }
  if (/tagged bookmarks before untagged/.test(s)) {
    return "Yes — the digest lists tagged bookmarks before untagged ones.";
  }
  return "The spec as I received it does not settle which kind of bookmark the digest lists first.";
}

export interface SeatPlay {
  restatement: RequirementEntry[];
  probeAnswer?: string;
}

/** Play one seat with the stub: run the step's scripted ops in order. */
export function playStubSeat(
  input: RequirementEntry[],
  script: TelephoneStubOp[],
): SeatPlay {
  let restatement = input.map((e) => ({ ...e }));
  let probeAnswer: string | undefined;
  for (const op of script) {
    if (op.op === "answerProbe") {
      // The probe is answered from the spec as received, before the
      // seat restates (the injection is delivered before the step).
      probeAnswer = composeProbeAnswer(input);
    } else {
      restatement = applyRestate(input, op);
    }
  }
  return { restatement, probeAnswer };
}

// ---------------------------------------------------------------------------
// Stated expectations (quoted from the scenario's variant descriptions).
// A miss is a finding about the scenario, reported — never tuned away.

export interface ExpectationVerdict {
  id: string;
  stated: string;
  actual: string;
  verdict: "pass" | "miss";
  note?: string;
}

interface RunFacts {
  chain: ChainScore;
  probeCorrect: boolean;
  endSum: number;
  seedCount: number;
}

function formatSum(sum: number, count: number): string {
  const rounded = Math.round(sum * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded}/${count}`;
}

function firstLossPosition(chain: ChainScore): number | null {
  const pos = chain.positions.find((p) => p.fidelity < 1);
  return pos ? pos.position : null;
}

const STATED_EXPECTATIONS: Record<
  string,
  { id: string; stated: string; check: (f: RunFacts) => string | null; onMiss?: string }[]
> = {
  "faithful-chain": [
    {
      id: "fidelity-all-positions",
      stated: "fidelity 1.0 at all five positions",
      check: (f) =>
        f.chain.positions.every((p) => p.fidelity === 1)
          ? null
          : `curve ${f.chain.positions.map((p) => p.fidelity).join(", ")}`,
    },
    {
      id: "probe-answer",
      stated: "a correct probe answer",
      check: (f) => (f.probeCorrect ? null : "probe answer incorrect"),
    },
  ],
  "negation-loss": [
    {
      id: "end-of-chain-fidelity",
      stated: "end-of-chain fidelity 11.5/12 (R10 scores 0, R4 scores 0.5)",
      check: (f) =>
        Math.abs(f.endSum - 11.5) < 1e-9
          ? null
          : `end-of-chain fidelity ${formatSum(f.endSum, f.seedCount)}`,
      onMiss:
        "The stated 11.5/12 does not follow from the scenario's own scoring definition: an absent requirement scores 0 and an altered one 0.5, so ten intact requirements plus R10 dropped (0) plus R4 altered (0.5) sum to 10.5/12. The scorer implements the definition as written; the defect is the variant description's arithmetic. Canon fix, in espetey/act: the negation-loss description should read 10.5/12.",
    },
    {
      id: "loss-enters-at-position-3",
      stated: "the loss entering the curve at position 3",
      check: (f) => {
        const first = firstLossPosition(f.chain);
        return first === 3 ? null : `first loss at position ${first ?? "none"}`;
      },
    },
  ],
  truncation: [
    {
      id: "end-of-chain-fidelity",
      stated: "end-of-chain fidelity at most 6/12",
      check: (f) =>
        f.endSum <= 6 + 1e-9
          ? null
          : `end-of-chain fidelity ${formatSum(f.endSum, f.seedCount)}`,
    },
    {
      id: "loss-enters-at-position-4",
      stated: "entering the curve at position 4",
      check: (f) => {
        const first = firstLossPosition(f.chain);
        return first === 4 ? null : `first loss at position ${first ?? "none"}`;
      },
    },
  ],
};

function evaluateExpectations(variantId: string, facts: RunFacts): ExpectationVerdict[] {
  return (STATED_EXPECTATIONS[variantId] ?? []).map((exp) => {
    const miss = exp.check(facts);
    return miss === null
      ? { id: exp.id, stated: exp.stated, actual: "as stated", verdict: "pass" as const }
      : {
          id: exp.id,
          stated: exp.stated,
          actual: miss,
          verdict: "miss" as const,
          ...(exp.onMiss ? { note: exp.onMiss } : {}),
        };
  });
}

// ---------------------------------------------------------------------------
// Run records and the runner

export interface GameRunManifest {
  manifestVersion: 1;
  kind: "labs-game-dry-run";
  gameId: string;
  scenarioSlug: string;
  scenarioVersion: string;
  registryExperiment: string;
  variantId: string;
  condition: GameConditionKind;
  conditionLetter: string;
  runId: string;
  runtimeId: string;
  adapter: string;
  seed: number;
  planPosition: number;
  startedAt: string;
  endedAt: string;
  wallTimeSeconds: number;
  harnessVersion: string;
  budget: GameScenarioConfig["budget"];
  stopRule: string;
  outcome: { status: "completed"; checks: CheckResult[] };
  fidelity: {
    curve: number[];
    endFidelity: number;
    endSum: string;
    positions: {
      position: number;
      fidelity: number;
      omissions: number;
      distortions: number;
      contradictions: number;
      scores: { id: string; score: number; verdict: string; detail: string }[];
    }[];
  };
  probe: {
    question: string | null;
    answer: string | null;
    correct: boolean;
    detail: string;
    receivedR7: string | null;
  };
  expectations: ExpectationVerdict[];
  knownLimitations: string[];
  artifacts: string[];
  privacyClassification: "synthetic-fixture";
}

export interface GameRunOutcome {
  runId: string;
  runDir: string;
  manifest: GameRunManifest;
}

export interface GameRunOptions {
  runsDir: string;
  seed?: number | string;
}

const STUB_LIMITATION =
  "Dry run: seats were played by the deterministic stub adapter (scripted restatements, not model behavior). The run proves the game's plumbing — seats fill, the driver fires, the scorer produces numbers — and its scripted outcomes are labeled expectations, never results.";

const LOCAL_DOUBLE_LIMITATION =
  "The moonbooth conditions ran against a local record double, not the production service; no booth was created on moonbooth.ai.";

function evaluateChecks(
  scenario: GameScenarioConfig,
  chain: ChainScore,
  probe: { correct: boolean; detail: string },
  endSum: number,
): CheckResult[] {
  return scenario.checks.map((check) => {
    const weight = check.weight ?? 1;
    if (check.id === "end-of-chain-fidelity") {
      return {
        id: check.id,
        kind: check.kind,
        description: check.description,
        passed: chain.endFidelity === 1,
        score: chain.endFidelity,
        weight,
        detail: `end-of-chain fidelity ${formatSum(endSum, scenario.seedRequirements.length)} (${chain.endFidelity})`,
        detectsMissedChange: check.detectsMissedChange,
      };
    }
    if (check.id === "fidelity-curve") {
      const mean =
        Math.round(
          (chain.positions.reduce((acc, p) => acc + p.fidelity, 0) /
            Math.max(1, chain.positions.length)) *
            10000,
        ) / 10000;
      return {
        id: check.id,
        kind: check.kind,
        description: check.description,
        passed: chain.positions.every((p) => p.fidelity === 1),
        score: mean,
        weight,
        detail: `fidelity by position: ${chain.positions.map((p) => p.fidelity).join(", ")}`,
        detectsMissedChange: check.detectsMissedChange,
      };
    }
    if (check.id === "probe-answer") {
      return {
        id: check.id,
        kind: check.kind,
        description: check.description,
        passed: probe.correct,
        score: probe.correct ? 1 : 0,
        weight,
        detail: probe.detail,
        detectsMissedChange: check.detectsMissedChange,
      };
    }
    return {
      id: check.id,
      kind: check.kind,
      description: check.description,
      passed: false,
      score: 0,
      weight,
      detail: "not evaluated by the game runner",
      detectsMissedChange: check.detectsMissedChange,
    };
  });
}

/**
 * Run the telephone game end to end with the stub adapter: every
 * variant under every condition in the scenario, in scenario order.
 * Writes one immutable run directory per run under
 * `<runsDir>/<game-id>/<run-id>/` and returns the run records.
 */
export async function runGame(
  scenario: GameScenarioConfig,
  opts: GameRunOptions,
): Promise<GameRunOutcome[]> {
  const version = await harnessVersion();
  const seed = normalizeSeed(opts.seed ?? 1);
  const runtime = scenario.runtimes.find((r) => r.adapter === "stub") ?? {
    id: "stub",
    adapter: "stub" as const,
  };
  const outcomes: GameRunOutcome[] = [];
  let position = 0;

  for (const variant of scenario.variants) {
    for (const condition of scenario.conditions) {
      const runId = `${scenario.id}-${variant.id}-${condition}-s${seed}-p${position}`;
      const runDir = path.join(opts.runsDir, scenario.id, runId);
      await mkdir(path.dirname(runDir), { recursive: true });
      await mkdir(runDir, { recursive: false }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") {
          throw new Error(
            `Run directory already exists: ${runDir}. Run records are immutable; choose a different seed or remove the old run directory deliberately.`,
          );
        }
        throw err;
      });

      const startedAt = new Date();
      const startedMs = Date.now();
      const channel = createChainChannel(condition);
      // Driver: seed before step 0.
      channel.seed(scenario.seedRequirements);

      const restatements: RequirementEntry[][] = [];
      let probeAnswer: string | null = null;
      let probeReceivedR7: string | null = null;
      let probeQuestion: string | null = null;

      variant.steps.forEach((step, stepIndex) => {
        const input =
          stepIndex === 0
            ? scenario.seedRequirements.map((e) => ({ ...e }))
            : channel.latest();
        const injection = scenario.injections.find(
          (i) => i.beforeStepIndex === stepIndex,
        );
        const play = playStubSeat(input, step.script ?? []);
        if (play.probeAnswer !== undefined) {
          probeAnswer = play.probeAnswer;
          probeQuestion = injection?.question ?? null;
          probeReceivedR7 = input.find((e) => e.id === "R7")?.statement ?? null;
        }
        restatements.push(play.restatement);
        channel.post(step.seat, play.restatement);
      });

      const chain = scoreChain(scenario.seedRequirements, restatements);
      const probe = scoreProbeAnswer(probeAnswer);
      const lastScores = chain.positions[chain.positions.length - 1]?.scores ?? [];
      const endSum = lastScores.reduce((acc, s) => acc + s.score, 0);
      const expectations = evaluateExpectations(variant.id, {
        chain,
        probeCorrect: probe.correct,
        endSum,
        seedCount: scenario.seedRequirements.length,
      });
      const checks = evaluateChecks(scenario, chain, probe, endSum);

      const manifest: GameRunManifest = {
        manifestVersion: 1,
        kind: "labs-game-dry-run",
        gameId: scenario.id,
        scenarioSlug: scenario.slug,
        scenarioVersion: scenario.version,
        registryExperiment: scenario.game.registry.experiment,
        variantId: variant.id,
        condition,
        conditionLetter: GAME_CONDITION_LETTERS[condition],
        runId,
        runtimeId: runtime.id,
        adapter: runtime.adapter,
        seed,
        planPosition: position,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        wallTimeSeconds: Math.round(((Date.now() - startedMs) / 1000) * 1000) / 1000,
        harnessVersion: version,
        budget: scenario.budget,
        stopRule: scenario.stopRule,
        outcome: { status: "completed", checks },
        fidelity: {
          curve: chain.positions.map((p) => p.fidelity),
          endFidelity: chain.endFidelity,
          endSum: formatSum(endSum, scenario.seedRequirements.length),
          positions: chain.positions.map((p) => ({
            position: p.position,
            fidelity: p.fidelity,
            omissions: p.omissions,
            distortions: p.distortions,
            contradictions: p.contradictions,
            scores: p.scores.map((s) => ({
              id: s.id,
              score: s.score,
              verdict: s.verdict,
              detail: s.detail,
            })),
          })),
        },
        probe: {
          question: probeQuestion,
          answer: probeAnswer,
          correct: probe.correct,
          detail: probe.detail,
          receivedR7: probeReceivedR7,
        },
        expectations,
        knownLimitations: [
          ...scenario.knownLimitations,
          STUB_LIMITATION,
          ...(condition === "transcript" ? [] : [LOCAL_DOUBLE_LIMITATION]),
        ],
        artifacts: ["manifest.json", "restatements.json", "probe.json", channel.artifactName],
        privacyClassification: "synthetic-fixture",
      };

      await writeFile(
        path.join(runDir, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8",
      );
      await writeFile(
        path.join(runDir, "restatements.json"),
        JSON.stringify(
          restatements.map((entries, i) => ({ seat: i + 1, entries })),
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await writeFile(
        path.join(runDir, "probe.json"),
        JSON.stringify(manifest.probe, null, 2) + "\n",
        "utf8",
      );
      await writeFile(path.join(runDir, channel.artifactName), channel.artifactText(), "utf8");

      outcomes.push({ runId, runDir, manifest });
      position++;
    }
  }
  return outcomes;
}

/** The dry-run summary: the durable record of a canon-requirement-3 run. */
export function buildDryRunSummary(
  scenario: GameScenarioConfig,
  outcomes: GameRunOutcome[],
  seed: number | string,
) {
  const findings: string[] = [];
  for (const o of outcomes) {
    for (const exp of o.manifest.expectations) {
      if (exp.verdict === "miss") {
        findings.push(
          `${o.manifest.variantId} (${o.manifest.condition}): stated "${exp.stated}", observed ${exp.actual}.${exp.note ? ` ${exp.note}` : ""}`,
        );
      }
    }
  }
  return {
    kind: "stub-dry-run",
    label:
      "Stub dry run for gamebook canon requirement 3 (a stub-adapter run proving the game runs end to end at zero model cost). Scripted outcomes are labeled expectations, never results.",
    game: {
      id: scenario.id,
      slug: scenario.slug,
      scenarioVersion: scenario.version,
      scenarioFile: `scenarios/${scenario.id.toLowerCase()}-${scenario.slug}.json`,
      registryExperiment: scenario.game.registry.experiment,
      canonSpec: "docs/gamebook.md (espetey/act)",
    },
    runtime: { adapter: "stub", model: "stub-scripted" },
    budget: scenario.budget,
    seed: normalizeSeed(seed),
    runs: outcomes.map((o) => ({
      runId: o.runId,
      variant: o.manifest.variantId,
      condition: o.manifest.condition,
      conditionLetter: o.manifest.conditionLetter,
      fidelityCurve: o.manifest.fidelity.curve,
      endFidelity: o.manifest.fidelity.endFidelity,
      endSum: o.manifest.fidelity.endSum,
      probeCorrect: o.manifest.probe.correct,
      expectations: o.manifest.expectations,
    })),
    findings,
  };
}
