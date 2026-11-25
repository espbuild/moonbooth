#!/usr/bin/env node
/**
 * Reference evaluation for the ACT verification harness.
 *
 * Runs the deterministic behavioral harness on the competitor-research
 * example package (its public cases plus fixture documents for them)
 * and on the independent validation cases in ../fixtures. Prints the
 * baseline and with-capability scores side by side. Every number
 * printed here is computed by the harness during this run.
 *
 * Usage: npm run build first, then `node scripts/run-reference-evaluation.mjs`
 * from packages/verification, or `npm run eval:reference`.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackageFromDirectory } from "@moonbooth/protocol";
import { buildSuiteFromPublicCases, runHarness, runVerification } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const exampleDir = join(repoRoot, "examples", "competitor-research");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function printSuite(title, suite, harness) {
  console.log(`\n== ${title} (suite ${suite.suite_id} v${suite.version}) ==`);
  for (const c of harness.result.cases) {
    console.log(
      `case ${c.caseId}: baseline overall ${c.baseline.scores.overall} | with-capability overall ${c.withCapability.scores.overall} | result ${c.result}`,
    );
    console.log(
      `  baseline criteria: completeness ${c.baseline.scores.completeness}, evidence attribution ${c.baseline.scores.evidenceAttribution}, missing data ${c.baseline.scores.missingDataHandling}, structure ${c.baseline.scores.outputStructure}, unsupported assertions score ${c.baseline.scores.unsupportedAssertions}`,
    );
    console.log(
      `  with-capability criteria: completeness ${c.withCapability.scores.completeness}, evidence attribution ${c.withCapability.scores.evidenceAttribution}, missing data ${c.withCapability.scores.missingDataHandling}, structure ${c.withCapability.scores.outputStructure}, unsupported assertions score ${c.withCapability.scores.unsupportedAssertions}`,
    );
  }
  console.log(
    `aggregate: baseline overall ${harness.result.aggregate.baseline.overall} | with-capability overall ${harness.result.aggregate.withCapability.overall} | label ${harness.result.label}`,
  );
}

const pkg = await loadPackageFromDirectory(exampleDir);
const skillText = new TextDecoder().decode(
  pkg.files.find((f) => f.path === "SKILL.md").content,
);
const publicCases = await readJson(join(exampleDir, "tests", "public-cases.json"));
const publicFixtures = await readJson(join(here, "..", "fixtures", "public-case-fixtures.json"));
const publicSuite = buildSuiteFromPublicCases(
  publicCases,
  publicFixtures.documents_by_case,
  publicFixtures.missing_by_case,
);
printSuite("Competitor research: public cases", publicSuite, runHarness(publicSuite, skillText));

const validationSuite = await readJson(join(here, "..", "fixtures", "validation-cases.json"));
printSuite("Independent validation cases", validationSuite, runHarness(validationSuite, skillText));

// Full engine run on the example package with the combined suite.
const combined = {
  suite_id: "competitor-research-reference",
  version: "1.0.0",
  cases: [...publicSuite.cases, ...validationSuite.cases],
};
const result = runVerification({
  manifest: pkg.manifest,
  files: pkg.files,
  profile: {
    adapter_id: "reference-evaluation",
    available_tools: ["web-search", "web-fetch"],
    granted_permissions: { network: true, filesystem_write: false, external_side_effects: false },
    notes: "Reference evaluation profile: search and fetch granted, no writes.",
  },
  transferId: "reference-evaluation",
  testSuite: combined,
  env: {},
});
console.log("\n== Full engine run on the example package ==");
console.log(`structural: ${result.structural.label}`);
console.log(`security: ${result.security.label} (${result.security.findings.length} findings)`);
console.log(`compatibility: ${result.compatibility.outcome}`);
console.log(`behavioral: ${result.behavioral.label}`);
console.log(`model grader: ${result.modelGrader.status} (${result.modelGrader.reason})`);
console.log(`overall: ${result.overall}`);
console.log(`receipt structural_result: ${result.receipt.structural_result}, security_result: ${result.receipt.security_result}, compatibility_result: ${result.receipt.compatibility_result}`);
