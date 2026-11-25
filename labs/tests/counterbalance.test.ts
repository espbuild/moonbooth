import { describe, expect, it } from "vitest";
import { conditionOrder, normalizeSeed, rotate } from "../src/rng.js";
import { planRuns } from "../src/engine.js";
import { loadScenario } from "../src/config.js";
import path from "node:path";
import { LABS_ROOT } from "../src/engine.js";

const CONDITIONS = ["files", "git", "moonbooth"] as const;

describe("counterbalanced condition ordering", () => {
  it("is deterministic for a given seed", () => {
    for (let p = 0; p < 3; p++) {
      expect(conditionOrder(CONDITIONS, p, 42)).toEqual(conditionOrder(CONDITIONS, p, 42));
    }
  });

  it("rotates through a Latin square across positions", () => {
    const orders = [0, 1, 2].map((p) => conditionOrder(CONDITIONS, p, 7));
    // Consecutive positions are rotations of one another.
    expect(orders[1]).toEqual(rotate(orders[0], 1));
    expect(orders[2]).toEqual(rotate(orders[0], 2));
    // Every condition occupies every position exactly once in the square.
    for (let position = 0; position < 3; position++) {
      const seen = new Set(orders.map((o) => o[position]));
      expect(seen).toEqual(new Set(CONDITIONS));
    }
  });

  it("a different seed shifts the square", () => {
    const a = conditionOrder(CONDITIONS, 0, 1);
    const b = conditionOrder(CONDITIONS, 0, 2);
    expect(a).not.toEqual(b);
    // Both are still rotations of the condition list.
    expect([...a].sort()).toEqual([...CONDITIONS].sort());
    expect([...b].sort()).toEqual([...CONDITIONS].sort());
  });

  it("normalizes string seeds stably", () => {
    expect(normalizeSeed("campaign-1")).toBe(normalizeSeed("campaign-1"));
    expect(normalizeSeed("campaign-1")).not.toBe(normalizeSeed("campaign-2"));
  });

  it("planRuns covers every variant under every condition exactly once", async () => {
    const scenario = await loadScenario(
      path.join(LABS_ROOT, "scenarios", "mb-01-cross-agent-build.json"),
    );
    const planned = planRuns(scenario, { runsDir: "/tmp/unused", seed: 5 });
    expect(planned).toHaveLength(9);
    const keys = new Set(planned.map((p) => `${p.variant.id}:${p.condition}`));
    expect(keys.size).toBe(9);
    const runIds = new Set(planned.map((p) => p.runId));
    expect(runIds.size).toBe(9);
    // Plan positions are a clean 0..8 sequence.
    expect(planned.map((p) => p.planPosition)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
