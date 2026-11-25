import type { PackageFile, ResultLabel } from "@moonbooth/protocol";

/**
 * Shared types for the ACT verification engine.
 *
 * The engine takes a parsed package (manifest plus payload files) and a
 * recipient environment profile, runs structural, security,
 * compatibility, and behavioral checks, and returns a structured
 * result plus a protocol receipt. Every check that did not run is
 * reported as missing or unsupported; nothing is reported as passed
 * when it did not run.
 */

export interface EnvironmentProfile {
  /** Adapter or environment identifier. Also used as the profile id. */
  adapter_id: string;
  description?: string;
  available_tools: string[];
  /** Permissions the recipient environment grants, by manifest name. */
  granted_permissions: Record<string, boolean>;
  /** Configuration entry names the environment can supply. */
  configuration?: string[];
  notes?: string;
}

export interface PolicyCeiling {
  /** When true, a package requesting external side effects is a policy flag. */
  flag_external_side_effects?: boolean;
}

export interface StructuralCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface StructuralResult {
  label: ResultLabel; // VALIDATED or FAILED
  checks: StructuralCheck[];
  errors: Array<{ code: string; path?: string; message: string }>;
  computedDigest: string | null;
  manifestDigest: string | null;
}

export type PolicySeverity = "blocking" | "warning" | "info";

export interface PolicyFinding {
  kind: string;
  severity: PolicySeverity;
  file: string;
  line: number;
  message: string;
}

export interface SecurityResult {
  label: ResultLabel; // POLICY_CHECKS_PASSED or FAILED
  findings: PolicyFinding[];
  /** Plain statement of what passing means and does not mean. */
  limitation: string;
}

export type CompatibilityOutcome =
  | "compatible"
  | "compatible_with_adaptation"
  | "missing_dependencies"
  | "unsupported"
  | "unknown";

export interface CompatibilityResult {
  outcome: CompatibilityOutcome;
  /** Receipt label the outcome maps to. */
  label: ResultLabel;
  reasons: string[];
  missingTools: string[];
  ungrantedPermissions: string[];
  missingConfiguration: string[];
  adaptations: string[];
}

export interface FixtureFact {
  kind: "feature" | "pricing" | "segment" | "positioning" | "claim";
  key: string;
  value: string;
  /** True when the fact is a company claim, not checked evidence. */
  claim?: boolean;
  /** Claims that share a topic can be checked against each other. */
  topic?: string;
}

export interface FixtureDocument {
  source: string;
  date: string;
  company: string;
  facts: FixtureFact[];
}

export interface MissingItem {
  company: string;
  topic: string;
  settle: string;
}

export interface TestCase {
  id: string;
  task: string;
  market: string;
  segments: string[];
  companies: string[];
  documents: FixtureDocument[];
  missing: MissingItem[];
}

export interface TestSuiteData {
  suite_id: string;
  version: string;
  cases: TestCase[];
}

export interface CaseScores {
  completeness: number;
  evidenceAttribution: number;
  missingDataHandling: number;
  outputStructure: number;
  unsupportedAssertions: number;
  overall: number;
}

export interface CaseRun {
  caseId: string;
  baseline: { output: string; scores: CaseScores };
  withCapability: { output: string; scores: CaseScores };
  result: ResultLabel;
}

export interface BehavioralResult {
  label: ResultLabel;
  performed: boolean;
  suite: { id: string; version: string } | null;
  cases: CaseRun[];
  aggregate: { baseline: CaseScores; withCapability: CaseScores } | null;
  summary: string;
}

export interface EvidenceItem {
  id: string;
  caseId: string;
  run: "baseline" | "with-capability";
  output: string;
}

export interface ModelGraderResult {
  status: "NOT_TESTED";
  reason: string;
}

export interface VerificationInput {
  manifest: unknown;
  files: PackageFile[];
  profile?: EnvironmentProfile | null;
  transferId?: string;
  /** Recorded digest from the hosting layer, when one exists. */
  expectedDigest?: string;
  /** Rich test suite supplied by the caller; when omitted the engine
   * tries to load one from the package test manifest. */
  testSuite?: TestSuiteData | null;
  policyCeiling?: PolicyCeiling;
  humanApprovalStatus?: "APPROVED" | "REJECTED" | "PENDING" | "NOT_REQUIRED";
  adoptionStatus?: "ADOPTED" | "NOT_ADOPTED" | "PENDING";
  /** Environment used only to check whether a model grader key exists. */
  env?: Record<string, string | undefined>;
}

export interface VerificationResult {
  structural: StructuralResult;
  security: SecurityResult;
  compatibility: CompatibilityResult;
  behavioral: BehavioralResult;
  modelGrader: ModelGraderResult;
  evidence: EvidenceItem[];
  missingChecks: string[];
  unsupportedChecks: string[];
  limitations: string[];
  /** VERIFIED when structural and security checks pass; FAILED otherwise. */
  overall: "VERIFIED" | "FAILED";
  receipt: import("@moonbooth/protocol").ActReceipt;
}
