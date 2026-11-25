import {
  buildReceipt,
  validateManifest,
  type ActManifest,
  type PackageFile,
} from "@moonbooth/protocol";
import { assessCompatibility } from "./compatibility.js";
import { runModelGrader } from "./grader.js";
import { runHarness } from "./harness.js";
import { verifySecurity, SECURITY_LIMITATION } from "./policy.js";
import { verifyStructural } from "./structural.js";
import type {
  BehavioralResult,
  TestSuiteData,
  VerificationInput,
  VerificationResult,
} from "./types.js";

/**
 * Verification engine entry point.
 *
 * Takes a parsed package plus a recipient environment profile and
 * returns the full structured result and a protocol receipt. The
 * engine is deterministic and offline. The only component that could
 * use a network is the optional model grader, and this build reports
 * it NOT_TESTED (see grader.ts).
 */

function textOf(files: PackageFile[], path: string): string | null {
  const file = files.find((f) => f.path === path);
  if (!file) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(file.content);
}

interface LoadedSuite {
  suite: TestSuiteData | null;
  suiteId: string;
  suiteVersion: string;
  problem: string | null;
}

/** Load a rich test suite from the package's own test manifest. */
function loadSuiteFromPackage(manifest: ActManifest | null, files: PackageFile[]): LoadedSuite {
  const fallback = { suite: null, suiteId: "none", suiteVersion: "0.0.0", problem: null as string | null };
  if (!manifest) return { ...fallback, problem: "The manifest did not validate, so no test suite could be read." };
  const manifestText = textOf(files, manifest.verification.test_manifest);
  if (!manifestText) {
    return { ...fallback, problem: `The test manifest ${manifest.verification.test_manifest} is not in the package.` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    return { ...fallback, problem: "The test manifest is not valid JSON." };
  }
  const suiteId = typeof parsed.suite_id === "string" ? parsed.suite_id : "none";
  const suiteVersion = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  const named = { ...fallback, suiteId, suiteVersion };

  // A suite embedded in the test manifest itself.
  if (Array.isArray(parsed.cases)) {
    const suite = suiteFromUnknown(parsed);
    if (suite) return { ...named, suite, suiteId: suite.suite_id, suiteVersion: suite.version };
    return { ...named, problem: "The test manifest lists cases without fixture documents, so the behavioral harness cannot run them." };
  }
  if (typeof parsed.cases_file === "string") {
    const casesText = textOf(files, parsed.cases_file);
    if (!casesText) {
      return { ...named, problem: `The cases file ${parsed.cases_file} named by the test manifest is not in the package.` };
    }
    let casesParsed: unknown;
    try {
      casesParsed = JSON.parse(casesText);
    } catch {
      return { ...named, problem: "The cases file is not valid JSON." };
    }
    const suite = suiteFromUnknown(casesParsed);
    if (suite) return { ...named, suite, suiteId: suite.suite_id, suiteVersion: suite.version };
    return {
      ...named,
      problem:
        "The cases file lists cases without fixture documents. The behavioral harness needs synthetic fixture documents per case, so these cases cannot run here.",
    };
  }
  return { ...named, problem: "The test manifest names no cases file, so no behavioral cases are available." };
}

/** Accept only the rich suite shape: cases with fixture documents. */
export function suiteFromUnknown(value: unknown): TestSuiteData | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.suite_id !== "string" || typeof v.version !== "string") return null;
  if (!Array.isArray(v.cases) || v.cases.length === 0) return null;
  for (const c of v.cases) {
    if (typeof c !== "object" || c === null) return null;
    const tc = c as Record<string, unknown>;
    if (typeof tc.id !== "string" || !Array.isArray(tc.documents) || tc.documents.length === 0) {
      return null;
    }
    if (!Array.isArray(tc.companies) || typeof tc.market !== "string" || !Array.isArray(tc.segments)) {
      return null;
    }
  }
  return value as unknown as TestSuiteData;
}

export function runVerification(input: VerificationInput): VerificationResult {
  const manifestCheck = validateManifest(input.manifest);
  const manifest: ActManifest | null = manifestCheck.ok ? manifestCheck.value : null;

  const structural = verifyStructural({
    manifest: input.manifest,
    files: input.files,
    expectedDigest: input.expectedDigest,
  });
  const security = verifySecurity({
    manifest,
    files: input.files,
    policyCeiling: input.policyCeiling,
  });
  const compatibility = assessCompatibility({ manifest, profile: input.profile ?? null });
  const modelGrader = runModelGrader(input.env ?? process.env);

  // Behavioral harness.
  const missingChecks: string[] = [];
  const unsupportedChecks: string[] = [`model grader: ${modelGrader.reason}`];
  let suiteInfo: LoadedSuite = { suite: null, suiteId: "none", suiteVersion: "0.0.0", problem: null };
  let suite: TestSuiteData | null = input.testSuite ?? null;
  if (suite) {
    suiteInfo = { suite, suiteId: suite.suite_id, suiteVersion: suite.version, problem: null };
  } else {
    suiteInfo = loadSuiteFromPackage(manifest, input.files);
    suite = suiteInfo.suite;
  }

  let behavioral: BehavioralResult;
  let evidence: VerificationResult["evidence"] = [];
  if (suite) {
    const skillText = manifest ? (textOf(input.files, manifest.artifact.entrypoint) ?? "") : "";
    const run = runHarness(suite, skillText);
    behavioral = run.result;
    evidence = run.evidence;
    if (behavioral.label === "INSUFFICIENT_EVIDENCE") {
      missingChecks.push(`behavioral evidence: ${behavioral.summary}`);
    }
  } else {
    behavioral = {
      label: "NOT_TESTED",
      performed: false,
      suite: suiteInfo.suiteId !== "none" ? { id: suiteInfo.suiteId, version: suiteInfo.suiteVersion } : null,
      cases: [],
      aggregate: null,
      summary: suiteInfo.problem ?? "No behavioral test suite was available.",
    };
    missingChecks.push(`behavioral tests: ${behavioral.summary}`);
  }

  if (compatibility.outcome === "unknown") {
    missingChecks.push("compatibility assessment: no recipient environment profile was supplied");
  }

  const limitations = [
    SECURITY_LIMITATION,
    "Structural checks cover the package format rules and digest integrity. A digest match shows the bytes match the bytes that were digested; it does not show who sent them or that the content is safe.",
    "The behavioral harness is a deterministic text procedure over synthetic fixtures. It checks report shape and fixture use; it does not run a model and does not predict how a model will behave with the capability in a live environment.",
    `Model grader: ${modelGrader.reason}`,
  ];

  const overall: VerificationResult["overall"] =
    structural.label === "FAILED" || security.label === "FAILED" ? "FAILED" : "VERIFIED";

  const digestForReceipt =
    structural.computedDigest ??
    (structural.manifestDigest && /^[a-f0-9]{64}$/.test(structural.manifestDigest)
      ? structural.manifestDigest
      : "0".repeat(64));

  const receipt = buildReceipt({
    transfer_id: input.transferId ?? "local-verification",
    capability: {
      id: manifest?.capability.id ?? "unknown-capability",
      version: manifest?.capability.version ?? "0.0.0",
    },
    artifact_digest: digestForReceipt,
    environment: {
      adapter_id: input.profile?.adapter_id ?? "act-verification-engine",
      ...(input.profile?.description || input.profile?.notes
        ? { description: (input.profile.description ?? input.profile.notes ?? "").slice(0, 1000) }
        : {}),
    },
    structural_result: structural.label,
    security_result: security.label,
    compatibility_result: compatibility.label,
    behavioral_outcomes: behavioral.cases.map((c) => ({
      test_id: c.caseId,
      result: c.result,
      notes:
        `baseline overall ${c.baseline.scores.overall}; with-capability overall ${c.withCapability.scores.overall}. ` +
        `Baseline criteria: completeness ${c.baseline.scores.completeness}, evidence attribution ${c.baseline.scores.evidenceAttribution}, missing data ${c.baseline.scores.missingDataHandling}, structure ${c.baseline.scores.outputStructure}, unsupported assertions score ${c.baseline.scores.unsupportedAssertions}. ` +
        `With-capability criteria: completeness ${c.withCapability.scores.completeness}, evidence attribution ${c.withCapability.scores.evidenceAttribution}, missing data ${c.withCapability.scores.missingDataHandling}, structure ${c.withCapability.scores.outputStructure}, unsupported assertions score ${c.withCapability.scores.unsupportedAssertions}.`,
    })),
    test_suite: { id: suiteInfo.suiteId, version: suiteInfo.suiteVersion },
    evidence_references: evidence.map((e) => e.id),
    baseline_comparison: {
      performed: behavioral.performed,
      result: behavioral.performed ? behavioral.label : null,
      summary: behavioral.summary.slice(0, 2000),
    },
    missing_checks: missingChecks,
    unsupported_checks: unsupportedChecks,
    human_approval_status: input.humanApprovalStatus ?? "PENDING",
    adoption_status: input.adoptionStatus ?? "PENDING",
  });

  return {
    structural,
    security,
    compatibility,
    behavioral,
    modelGrader,
    evidence,
    missingChecks,
    unsupportedChecks,
    limitations,
    overall,
    receipt,
  };
}
