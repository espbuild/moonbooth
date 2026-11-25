import { describe, expect, it } from "vitest";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadScenario } from "../src/config.js";
import { LABS_ROOT, executeRun, planRuns } from "../src/engine.js";
import type { RunManifest } from "../src/manifest.js";

describe("run manifest completeness", () => {
  it("records every field the playbook's run manifest requires", async () => {
    const scenario = await loadScenario(
      path.join(LABS_ROOT, "scenarios", "mb-01-cross-agent-build.json"),
    );
    const runsDir = await mkdtemp(path.join(os.tmpdir(), "labs-manifest-"));
    const planned = planRuns(scenario, {
      runsDir,
      seed: 3,
      conditionsOverride: ["files"],
    }).find(
      (p) => p.variant.id === "coordinated-adoption" && p.condition === "files",
    )!;
    const outcome = await executeRun(scenario, planned, {
      runsDir,
      seed: 3,
      conditionsOverride: ["files"],
    });
    const m: RunManifest = outcome.manifest;

    // Identity and provenance.
    expect(m.experimentId).toBe("MB-01");
    expect(m.runId).toBe(planned.runId);
    expect(m.scenarioVersion).toBe(scenario.version);
    expect(m.seed).toBe(3);
    expect(m.planPosition).toBe(planned.planPosition);
    expect(m.conditionOrder).toEqual(["files"]);
    // Model/provider/revision as reported by the adapter.
    expect(m.model.provider).toBe("labs-stub");
    expect(m.model.model).toBe("stub-scripted");
    expect(m.model.revision).toBe("deterministic-v1");
    // Harness, tools, hardware.
    expect(m.harnessVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.tools.length).toBeGreaterThan(0);
    expect(m.hardware.length).toBeGreaterThan(0);
    // Condition and budget.
    expect(m.condition).toBe("files");
    expect(m.budget.maxWallTimeSecondsPerRun).toBe(
      scenario.budget.maxWallTimeSecondsPerRun,
    );
    expect(m.budgetBreaches).toEqual([]);
    expect(m.stopRule).toBe(scenario.stopRule);
    // Timing.
    expect(Date.parse(m.startedAt)).not.toBeNaN();
    expect(Date.parse(m.endedAt)).not.toBeNaN();
    expect(m.wallTimeSeconds).toBeGreaterThanOrEqual(0);
    // Outcome and test scores.
    expect(m.outcome.status).toBe("passed");
    expect(m.outcome.score).toBe(1);
    expect(m.outcome.checks).toHaveLength(scenario.checks.length);
    for (const check of m.outcome.checks) {
      expect(check.score).toBe(1);
      expect(check.passed).toBe(true);
    }
    // Failure category is present (null on a clean run).
    expect(m.failureCategory).toBeNull();
    // Usage: stub reports nothing, and nothing is estimated.
    expect(m.usage.inputTokens).toBe("not reported");
    expect(m.usage.costUsd).toBe("not reported");
    expect(m.usage.costMethod).toBe("not reported");
    // Metrics.
    expect(m.metrics.missedChanges).toBe(0);
    expect(m.metrics.reworkEvents).toBe(0);
    expect(m.metrics.interventions).toBe(0);
    // Artifacts and privacy classification.
    expect(m.artifacts).toContain("manifest.json");
    expect(m.privacyClassification).toBe("synthetic-fixture");
    // The artifacts exist on disk.
    for (const artifact of ["manifest.json", "events.jsonl", "export.json"]) {
      await expect(access(path.join(outcome.runDir, artifact))).resolves.toBeUndefined();
    }
    const onDisk = JSON.parse(
      await readFile(path.join(outcome.runDir, "manifest.json"), "utf8"),
    ) as RunManifest;
    expect(onDisk.runId).toBe(m.runId);
  });
});
