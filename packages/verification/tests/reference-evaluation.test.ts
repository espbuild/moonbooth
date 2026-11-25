import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackageFromDirectory } from "@moonbooth/protocol";
import {
  buildSuiteFromPublicCases,
  runHarness,
  runVerification,
  type TestSuiteData,
} from "../src/index.js";

/**
 * Reference evaluation: the competitor-research example package, its
 * public cases (with the synthetic fixture documents those cases
 * describe), and the independent validation cases in ../fixtures.
 * This is the same run as scripts/run-reference-evaluation.mjs; the
 * numbers asserted here are relations between computed scores, never
 * stored constants.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const exampleDir = join(repoRoot, "examples", "competitor-research");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("reference evaluation: competitor-research", () => {
  it("runs the public cases plus validation cases and beats the baseline", async () => {
    const pkg = await loadPackageFromDirectory(exampleDir);
    const skillText = new TextDecoder().decode(
      pkg.files.find((f) => f.path === "SKILL.md")!.content,
    );
    const fixtures = readJson(join(here, "..", "fixtures", "public-case-fixtures.json")) as {
      documents_by_case: Record<string, TestSuiteData["cases"][number]["documents"]>;
      missing_by_case: Record<string, TestSuiteData["cases"][number]["missing"]>;
    };
    const publicSuite = buildSuiteFromPublicCases(
      readJson(join(exampleDir, "tests", "public-cases.json")),
      fixtures.documents_by_case,
      fixtures.missing_by_case,
    );
    expect(publicSuite.cases).toHaveLength(3);
    expect(publicSuite.cases.every((c) => c.documents.length > 0)).toBe(true);

    const validationSuite = readJson(
      join(here, "..", "fixtures", "validation-cases.json"),
    ) as TestSuiteData;
    // Independent cases use companies that are not in the example package.
    const publicCompanies = new Set(publicSuite.cases.flatMap((c) => c.companies));
    for (const c of validationSuite.cases) {
      for (const company of c.companies) expect(publicCompanies.has(company)).toBe(false);
    }

    const combined: TestSuiteData = {
      suite_id: "competitor-research-reference",
      version: "1.0.0",
      cases: [...publicSuite.cases, ...validationSuite.cases],
    };
    const { result } = runHarness(combined, skillText);
    console.log(
      `reference evaluation: baseline overall ${result.aggregate?.baseline.overall}, with-capability overall ${result.aggregate?.withCapability.overall} over ${result.cases.length} cases`,
    );
    expect(result.cases).toHaveLength(6);
    expect(result.aggregate!.withCapability.overall).toBeGreaterThan(result.aggregate!.baseline.overall);
    expect(result.label).toBe("VERIFIED_FOR_TEST_SUITE");

    const full = runVerification({
      manifest: pkg.manifest,
      files: pkg.files,
      profile: {
        adapter_id: "reference-evaluation",
        available_tools: ["web-search", "web-fetch"],
        granted_permissions: { network: true, filesystem_write: false, external_side_effects: false },
      },
      transferId: "reference-evaluation",
      testSuite: combined,
      env: {},
    });
    expect(full.structural.label).toBe("VALIDATED");
    expect(full.security.label).toBe("POLICY_CHECKS_PASSED");
    expect(full.compatibility.outcome).toBe("compatible");
    expect(full.behavioral.label).toBe("VERIFIED_FOR_TEST_SUITE");
    expect(full.modelGrader.status).toBe("NOT_TESTED");
    expect(full.evidence).toHaveLength(12);
    expect(full.receipt.evidence_references).toHaveLength(12);
    expect(full.receipt.behavioral_outcomes).toHaveLength(6);
  });

  it("without a supplied suite, the package's own public cases cannot run and behavioral is NOT_TESTED", async () => {
    const pkg = await loadPackageFromDirectory(exampleDir);
    const result = runVerification({
      manifest: pkg.manifest,
      files: pkg.files,
      profile: {
        adapter_id: "reference-evaluation",
        available_tools: ["web-search", "web-fetch"],
        granted_permissions: { network: true },
      },
      env: {},
    });
    // The public cases file describes its sources in prose and carries
    // no fixture documents, so the harness cannot run them. The result
    // says so instead of reporting a pass.
    expect(result.behavioral.label).toBe("NOT_TESTED");
    expect(result.missingChecks.some((c) => c.includes("behavioral"))).toBe(true);
    expect(result.receipt.test_suite.id).toBe("competitor-research-public");
  });
});
