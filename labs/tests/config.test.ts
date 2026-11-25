import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadScenario, ScenarioValidationError } from "../src/config.js";
import { validateScenarioDocument } from "../src/schema.js";
import { LABS_ROOT } from "../src/engine.js";

const MB01 = path.join(LABS_ROOT, "scenarios", "mb-01-cross-agent-build.json");

describe("scenario config validation", () => {
  it("loads the shipped MB-01 scenario", async () => {
    const scenario = await loadScenario(MB01);
    expect(scenario.id).toBe("MB-01");
    expect(scenario.conditions).toEqual(["files", "git", "moonbooth"]);
    expect(scenario.variants.map((v) => v.id)).toEqual([
      "coordinated-adoption",
      "missed-change",
      "interface-drift",
    ]);
    expect(scenario.injections).toHaveLength(1);
    expect(scenario.injections[0].id).toBe("inj-pagination-v2");
  });

  it("rejects a document with a missing required field", () => {
    const errors = validateScenarioDocument({ id: "MB-99" });
    expect(errors.some((e) => e.includes("missing required"))).toBe(true);
  });

  it("rejects an unknown condition and an unknown adapter", async () => {
    const scenario = JSON.parse(
      JSON.stringify(await loadScenario(MB01)),
    ) as Record<string, unknown>;
    scenario.conditions = ["files", "smoke-signals"];
    expect(
      validateScenarioDocument(scenario).some((e) => e.includes("smoke-signals")),
    ).toBe(true);
    scenario.conditions = ["files"];
    (scenario.runtimes as { adapter: string }[])[0].adapter = "telepathy";
    expect(
      validateScenarioDocument(scenario).some((e) => e.includes("telepathy")),
    ).toBe(true);
  });

  it("rejects a step naming an unknown role", async () => {
    const scenario = JSON.parse(JSON.stringify(await loadScenario(MB01))) as {
      variants: { steps: { role: string }[] }[];
    };
    scenario.variants[0].steps[0].role = "ghost";
    expect(
      validateScenarioDocument(scenario).some((e) => e.includes('unknown role "ghost"')),
    ).toBe(true);
  });

  it("rejects a check detecting an unknown injection", async () => {
    const scenario = JSON.parse(JSON.stringify(await loadScenario(MB01))) as {
      checks: { detectsMissedChange?: string }[];
    };
    scenario.checks[0].detectsMissedChange = "inj-nope";
    expect(
      validateScenarioDocument(scenario).some((e) => e.includes("inj-nope")),
    ).toBe(true);
  });

  it("loadScenario throws ScenarioValidationError with the full list", async () => {
    await expect(loadScenario(path.join(LABS_ROOT, "package.json"))).rejects.toBeInstanceOf(
      ScenarioValidationError,
    );
  });
});
