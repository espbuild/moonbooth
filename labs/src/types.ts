// Core types for the Moonbooth Labs experiment harness.
//
// Evidence discipline (from the Labs playbook): a value the harness did
// not observe is recorded as the string "not reported", never estimated
// or filled in. `Reported<T>` makes that distinction explicit at every
// point where an adapter or a service may or may not supply a number.

export type Reported<T> = T | "not reported";

export const NOT_REPORTED = "not reported" as const;

export type ConditionKind = "files" | "git" | "moonbooth";
export type AdapterKind = "stub" | "codex" | "api-session";

export interface RoleDef {
  id: string;
  title: string;
  /** The area of the fixture codebase this role owns, e.g. "src/backend". */
  area: string;
  /** Standing brief for the role; real adapters receive it as instructions. */
  brief: string;
}

export interface RuntimeDef {
  id: string;
  adapter: AdapterKind;
  /** Model name to request/record, when the adapter takes one. */
  model?: string;
  options?: Record<string, unknown>;
}

export interface BudgetCaps {
  maxWallTimeSecondsPerRun: number;
  /** Null means cost is not capped (still recorded when reported). */
  maxCostUsdPerRun: number | null;
  maxInterventionsPerRun: number;
}

/**
 * One scripted operation for the stub adapter. The stub is a
 * deterministic stand-in for a model: it performs exactly these file
 * operations so tests and smoke runs exercise the full pipeline at zero
 * model cost. `writeServiceFromContract` / `writeClientFromContract`
 * are MB-01 fixture vocabulary: each writes the implementation that
 * matches the contract version present in the session workspace.
 */
export type StubOp =
  | { op: "writeServiceFromContract"; target: string }
  | { op: "writeClientFromContract"; target: string }
  | { op: "writeFile"; path: string; content: string }
  | { op: "appendFile"; path: string; content: string }
  | { op: "note"; text: string };

export interface StepDef {
  role: string;
  /**
   * Pull the channel's current shared state into the workspace before
   * the session. Default true. A step that sets this false works from
   * its seeded copy — which is how a variant scripts a missed change.
   */
  syncIn?: boolean;
  /** Publish the workspace's shared files to the channel afterwards. Default true. */
  syncOut?: boolean;
  /** Step-specific brief appended to the role brief for real adapters. */
  brief?: string;
  /** Stub adapter script for this step. */
  script?: StubOp[];
}

export interface VariantDef {
  id: string;
  description: string;
  /** Fixture directory, relative to the labs/ directory. */
  fixture: string;
  steps: StepDef[];
}

export interface InjectionDef {
  id: string;
  /** Applied by the driver immediately before this step index (0-based). */
  beforeStepIndex: number;
  description: string;
  /** Files written into the channel's shared area (the contract). */
  files: { path: string; content: string }[];
}

export interface CheckDef {
  id: string;
  kind: "command" | "fileExists" | "fileContains";
  description: string;
  /** Command checks: shell command run in the merged evaluation workspace. */
  command?: string;
  /** File checks: path relative to the merged evaluation workspace. */
  path?: string;
  contains?: string;
  weight?: number;
  /**
   * When a command check emits TAP-style "ok <name>" / "not ok <name>"
   * lines, partial credit is the fraction of assertions passed.
   */
  partialFromOutput?: boolean;
  /** Failure of this check counts as a missed change for this injection. */
  detectsMissedChange?: string;
}

export interface ScenarioConfig {
  id: string;
  slug: string;
  /** Scenario (protocol) version, recorded in every run manifest. */
  version: string;
  objective: string;
  hypothesis?: string;
  primaryMetric?: string;
  roles: RoleDef[];
  runtimes: RuntimeDef[];
  conditions: ConditionKind[];
  moonbooth?: { apiBaseUrl: string };
  budget: BudgetCaps;
  stopRule: string;
  variants: VariantDef[];
  injections: InjectionDef[];
  checks: CheckDef[];
  /** Known limitations, carried into every sanitized export verbatim. */
  knownLimitations: string[];
}

export interface HarnessEvent {
  t: string;
  kind: string;
  runId: string;
  role?: string;
  detail?: Record<string, unknown>;
}

export interface UsageReport {
  inputTokens: Reported<number>;
  outputTokens: Reported<number>;
  costUsd: Reported<number>;
  /** How cost was obtained: "adapter-reported", or "not reported". */
  costMethod: string;
}

export interface ModelReport {
  provider: Reported<string>;
  model: Reported<string>;
  revision: Reported<string>;
}

export interface SessionRequest {
  runId: string;
  role: RoleDef;
  stepIndex: number;
  workspace: string;
  brief: string;
  timeoutSeconds: number;
  runtime: RuntimeDef;
  /** Stub adapter only: the step's scripted operations. */
  script?: StubOp[];
  record: (kind: string, detail?: Record<string, unknown>) => void;
}

export interface SessionResult {
  status: "completed" | "failed" | "timeout";
  /** Short adapter-generated summary. Never treated as outcome evidence. */
  summary: string;
  usage: UsageReport;
  model: ModelReport;
  failureCategory?: string;
}

export interface CheckResult {
  id: string;
  kind: CheckDef["kind"];
  description: string;
  passed: boolean;
  /** 0..1; equals 1 or 0 unless the check supports partial credit. */
  score: number;
  weight: number;
  detail: string;
  detectsMissedChange?: string;
}
