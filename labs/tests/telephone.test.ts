import { beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGameScenario, loadScenario } from "../src/config.js";
import { validateScenarioDocument } from "../src/schema.js";
import { validateGameScenarioDocument } from "../src/games/schema.js";
import {
  scoreChain,
  scoreProbeAnswer,
  scoreRequirement,
  scoreRestatement,
} from "../src/games/scorer.js";
import {
  buildDryRunSummary,
  createChainChannel,
  renderProse,
  runGame,
  splitProse,
  type GameRunOutcome,
} from "../src/games/telephone.js";
import { LABS_ROOT } from "../src/engine.js";
import type { GameScenarioConfig, RequirementEntry } from "../src/games/types.js";

// MB-09 telephone game: the adopted canon scenario, the drift
// scorer's verdicts, and the canon-requirement-3 stub dry run. The
// dry-run expectations are the ones stated in the scenario's variant
// descriptions — including the one miss they produce (see the
// negation-loss test), which is a finding about the scenario.

const SCENARIO_PATH = path.join(
  LABS_ROOT,
  "scenarios",
  "mb-09-agent-telephone-game.json",
);

let scenario: GameScenarioConfig;
let seed: RequirementEntry[];

beforeAll(async () => {
  scenario = await loadGameScenario(SCENARIO_PATH);
  seed = scenario.seedRequirements;
});

function restate(mutate?: (entries: RequirementEntry[]) => RequirementEntry[]) {
  const entries = seed.map((e) => ({ ...e }));
  return mutate ? mutate(entries) : entries;
}

describe("MB-09 scenario adoption", () => {
  it("validates as a game scenario, game block and version preserved", () => {
    expect(scenario.id).toBe("MB-09");
    expect(scenario.version).toBe("1.0.0");
    expect(scenario.game.players.count).toBe(5);
    expect(scenario.game.registry.experiment).toBe("MB-09");
    expect(scenario.conditions).toEqual(["transcript", "moonbooth", "moonbooth-ablated"]);
    expect(scenario.seedRequirements).toHaveLength(12);
  });

  it("does not validate under the base scenario schema (the recorded format gap)", async () => {
    const raw = JSON.parse(await readFile(SCENARIO_PATH, "utf8")) as unknown;
    const errors = validateScenarioDocument(raw);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("game");
    await expect(loadScenario(SCENARIO_PATH)).rejects.toThrow(/validation failed/i);
  });

  it("the game validator rejects a document with no game block", async () => {
    const raw = JSON.parse(await readFile(SCENARIO_PATH, "utf8")) as Record<string, unknown>;
    delete raw.game;
    expect(validateGameScenarioDocument(raw).length).toBeGreaterThan(0);
  });
});

describe("drift scorer", () => {
  it("scores an identical restatement 1.0 with every requirement intact", () => {
    const scored = scoreRestatement(seed, restate());
    expect(scored.fidelity).toBe(1);
    expect(scored.scores.every((s) => s.verdict === "intact")).toBe(true);
  });

  it("scores a reworded restatement 1 when every consequential fact is intact", () => {
    const entries = restate((es) =>
      es.map((e) =>
        e.id === "R3"
          ? { ...e, statement: "The weekly digest email is known as the Sunday Sort." }
          : e,
      ),
    );
    const r3 = scoreRequirement(seed[2], entries[2]);
    expect(r3.score).toBe(1);
    expect(r3.verdict).toBe("intact");
  });

  it("scores a dropped requirement 0 as an omission", () => {
    const scored = scoreRestatement(seed, restate((es) => es.filter((e) => e.id !== "R10")));
    expect(scored.omissions).toBe(1);
    expect(scored.scores.find((s) => s.id === "R10")?.score).toBe(0);
    expect(scored.fidelity).toBeCloseTo(11 / 12, 4);
  });

  it("scores an altered number 0.5 as a distortion", () => {
    const entries = restate((es) =>
      es.map((e) =>
        e.id === "R4"
          ? { ...e, statement: "A bookmark leaves the inbox after 7 days unless it is tagged." }
          : e,
      ),
    );
    const r4 = scoreRequirement(seed[3], entries[3]);
    expect(r4.score).toBe(0.5);
    expect(r4.verdict).toBe("altered");
  });

  it("scores the inverted deleted/not-archived pair 0 as a contradiction", () => {
    const entries = restate((es) =>
      es.map((e) =>
        e.id === "R10"
          ? { ...e, statement: "Untagged bookmarks that expire are archived, not deleted." }
          : e,
      ),
    );
    const r10 = scoreRequirement(seed[9], entries[9]);
    expect(r10.score).toBe(0);
    expect(r10.verdict).toBe("contradicted");
  });

  it("scores a reversed ordering 0 as a contradiction", () => {
    const entries = restate((es) =>
      es.map((e) =>
        e.id === "R7"
          ? { ...e, statement: "The digest lists tagged bookmarks before untagged ones." }
          : e,
      ),
    );
    const r7 = scoreRequirement(seed[6], entries[6]);
    expect(r7.score).toBe(0);
    expect(r7.verdict).toBe("contradicted");
  });

  it("scores the probe answer against R7 as seeded", () => {
    expect(
      scoreProbeAnswer(
        "No — the digest lists untagged bookmarks before tagged ones, so tagged bookmarks are never listed first.",
      ).correct,
    ).toBe(true);
    expect(
      scoreProbeAnswer("Yes — the digest lists tagged bookmarks before untagged ones.").correct,
    ).toBe(false);
    expect(scoreProbeAnswer(null).correct).toBe(false);
  });

  it("the ablated channel's prose round-trips the full seed, email included", () => {
    const prose = renderProse(seed);
    const statements = splitProse(prose);
    expect(statements).toHaveLength(12);
    const channel = createChainChannel("moonbooth-ablated");
    channel.seed(seed);
    channel.post(1, seed);
    expect(channel.latest()).toEqual(seed);
    const handoff = channel.handoffs()[0];
    expect(handoff.form).toBe("free-text-event");
    expect(handoff.rendered).not.toContain("R1:");
  });
});

describe("MB-09 stub dry run (canon requirement 3)", () => {
  let outcomes: GameRunOutcome[];

  beforeAll(async () => {
    const runsDir = await mkdtemp(path.join(os.tmpdir(), "labs-mb09-"));
    outcomes = await runGame(scenario, { runsDir, seed: 1 });
  }, 120_000);

  function byVariantAndCondition() {
    const map = new Map<string, GameRunOutcome["manifest"]>();
    for (const o of outcomes) map.set(`${o.manifest.variantId}:${o.manifest.condition}`, o.manifest);
    return map;
  }

  it("produces nine runs: three variants under three conditions, each citing scenario 1.0.0", () => {
    expect(outcomes).toHaveLength(9);
    for (const o of outcomes) {
      expect(o.manifest.scenarioVersion).toBe("1.0.0");
      expect(o.manifest.adapter).toBe("stub");
      expect(o.manifest.kind).toBe("labs-game-dry-run");
    }
  });

  it("faithful-chain: fidelity 1.0 at every position, probe correct, all expectations met", () => {
    const map = byVariantAndCondition();
    for (const condition of scenario.conditions) {
      const m = map.get(`faithful-chain:${condition}`)!;
      expect(m.fidelity.curve).toEqual([1, 1, 1, 1, 1]);
      expect(m.fidelity.endFidelity).toBe(1);
      expect(m.probe.correct).toBe(true);
      expect(m.expectations.every((e) => e.verdict === "pass")).toBe(true);
    }
  });

  it("negation-loss: the curve enters at position 3 and ends at 10.5/12 — the stated 11.5/12 expectation is a miss", () => {
    const map = byVariantAndCondition();
    for (const condition of scenario.conditions) {
      const m = map.get(`negation-loss:${condition}`)!;
      expect(m.fidelity.curve).toEqual([1, 1, 0.9167, 0.875, 0.875]);
      expect(m.fidelity.endSum).toBe("10.5/12");
      expect(m.probe.correct).toBe(true);
      const miss = m.expectations.find((e) => e.verdict === "miss");
      expect(miss?.id).toBe("end-of-chain-fidelity");
      expect(miss?.stated).toContain("11.5/12");
      expect(miss?.actual).toContain("10.5/12");
      // The loss-entering expectation, stated separately, does pass.
      expect(
        m.expectations.find((e) => e.id === "loss-enters-at-position-3")?.verdict,
      ).toBe("pass");
    }
  });

  it("truncation: end fidelity 6/12, entering at position 4, expectations met", () => {
    const map = byVariantAndCondition();
    for (const condition of scenario.conditions) {
      const m = map.get(`truncation:${condition}`)!;
      expect(m.fidelity.curve).toEqual([1, 1, 1, 0.5, 0.5]);
      expect(m.fidelity.endSum).toBe("6/12");
      expect(m.expectations.every((e) => e.verdict === "pass")).toBe(true);
    }
  });

  it("the summary records the miss as a finding, once per condition", () => {
    const summary = buildDryRunSummary(scenario, outcomes, 1);
    expect(summary.runs).toHaveLength(9);
    expect(summary.findings).toHaveLength(3);
    expect(summary.findings[0]).toContain("10.5/12");
    expect(summary.game.scenarioVersion).toBe("1.0.0");
  });

  it("scoreChain over the recorded restatements reproduces the manifest curves", async () => {
    for (const o of outcomes) {
      const raw = JSON.parse(
        await readFile(path.join(o.runDir, "restatements.json"), "utf8"),
      ) as { seat: number; entries: RequirementEntry[] }[];
      const chain = scoreChain(seed, raw.map((r) => r.entries));
      expect(chain.positions.map((p) => p.fidelity)).toEqual(o.manifest.fidelity.curve);
    }
  });
});
