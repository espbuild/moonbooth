import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateBaseline,
  generateWithCapability,
  runHarness,
  scoreOutput,
  type TestSuiteData,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const validationSuite = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "validation-cases.json"), "utf8"),
) as TestSuiteData;

const FULL_SKILL = [
  "# Research",
  "Set the scope: name the market, companies, and segments.",
  "Gather notes and keep the source for every fact next to the fact; date every fact.",
  "Separate claims from evidence and mark each item as claim or evidence.",
  "Build a feature comparison table and a segment comparison table.",
  "Write positioning notes for each company.",
  "State missing information at the end. Use unknown in a cell when you have no source; do not guess.",
].join("\n");

describe("behavioral harness", () => {
  it("computes scores from the generated outputs, with-capability above baseline", () => {
    const { result } = runHarness(validationSuite, FULL_SKILL);
    expect(result.performed).toBe(true);
    expect(result.cases).toHaveLength(3);
    expect(result.aggregate).not.toBeNull();
    expect(result.aggregate!.withCapability.overall).toBeGreaterThan(result.aggregate!.baseline.overall);
    expect(result.label).toBe("VERIFIED_FOR_TEST_SUITE");
    for (const c of result.cases) {
      expect(c.withCapability.scores.overall).toBeGreaterThan(c.baseline.scores.overall);
      expect(c.withCapability.output).toContain("## Missing information");
      expect(c.baseline.output).not.toContain("## Missing information");
    }
  });

  it("states disagreements instead of picking a side on the conflicting case", () => {
    const testCase = validationSuite.cases.find((c) => c.id === "validation-conflicting-claims")!;
    const out = generateWithCapability(testCase, FULL_SKILL);
    expect(out).toContain("Sources disagree on no-show fees");
    const baseline = generateBaseline(testCase);
    expect(baseline).not.toContain("disagree");
  });

  it("names missing pricing in the missing section and guesses in the baseline", () => {
    const testCase = validationSuite.cases.find((c) => c.id === "validation-missing-pricing")!;
    const out = generateWithCapability(testCase, FULL_SKILL);
    const section = out.slice(out.indexOf("## Missing information"));
    expect(section).toContain("Coppertail");
    expect(section).toContain("pricing");
    const scores = scoreOutput(testCase, out);
    expect(scores.missingDataHandling).toBe(1);
    const baselineScores = scoreOutput(testCase, generateBaseline(testCase));
    expect(baselineScores.missingDataHandling).toBe(0);
  });

  it("scores a skill that omits the missing-information step worse on that criterion", () => {
    const testCase = validationSuite.cases.find((c) => c.id === "validation-missing-pricing")!;
    const partialSkill = FULL_SKILL.replace(
      "State missing information at the end. Use unknown in a cell when you have no source; do not guess.",
      "Wrap up when the tables are done.",
    );
    const full = scoreOutput(testCase, generateWithCapability(testCase, FULL_SKILL));
    const partial = scoreOutput(testCase, generateWithCapability(testCase, partialSkill));
    expect(partial.missingDataHandling).toBeLessThan(full.missingDataHandling);
    expect(partial.completeness).toBeLessThan(full.completeness);
    expect(generateWithCapability(testCase, partialSkill)).not.toContain("## Missing information");
  });

  it("gives an empty suite an INSUFFICIENT_EVIDENCE label", () => {
    const { result } = runHarness(
      { suite_id: "empty", version: "1.0.0", cases: [] },
      FULL_SKILL,
    );
    expect(result.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.performed).toBe(false);
  });

  it("is deterministic: two runs produce identical outputs and scores", () => {
    const a = runHarness(validationSuite, FULL_SKILL);
    const b = runHarness(validationSuite, FULL_SKILL);
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
  });
});
