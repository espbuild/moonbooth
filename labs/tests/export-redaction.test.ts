import { afterAll, describe, expect, it } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadScenario } from "../src/config.js";
import { LABS_ROOT, executeRun, planRuns } from "../src/engine.js";
import { assertExportSafe } from "../src/manifest.js";
import type { ScenarioConfig } from "../src/types.js";

// The sanitized export is built from an allowlist, so workspace
// contents can never flow into it. This test seeds a fixture whose
// files (and a scripted session note) carry credential-shaped strings
// and proves none of them reach the export — while the private event
// log does contain the note, proving the poison actually flowed
// through the run and the export's silence is structural, not luck.

const POISONS = [
  "Bearer POISONTOKEN1234567890",
  "https://www.moonbooth.ai/b/booth-poison-42?credential=POISONCRED42",
  "participant-credential-POISON42",
  "POISONNOTE42",
];

const tmpFixtureRoot = path.join(LABS_ROOT, "fixtures", ".tmp-redaction");

afterAll(async () => {
  await rm(tmpFixtureRoot, { recursive: true, force: true });
});

describe("sanitized export redaction", () => {
  it("assertExportSafe refuses a poisoned object", () => {
    expect(() => assertExportSafe({ note: "Bearer abcdefghij123456" })).toThrow(
      /refused/,
    );
    expect(() =>
      assertExportSafe({ link: "https://example.test/api/v1/booths/abc12345" }),
    ).toThrow(/refused/);
    expect(() => assertExportSafe({ fine: "ordinary summary text" })).not.toThrow();
  });

  it("a run seeded with credential-shaped strings exports none of them", async () => {
    const baseSrc = path.join(LABS_ROOT, "fixtures", "mb-01", "base");
    const fixtureDir = path.join(tmpFixtureRoot, "base");
    await mkdir(tmpFixtureRoot, { recursive: true });
    await cp(baseSrc, fixtureDir, { recursive: true });
    await writeFile(
      path.join(fixtureDir, "src", "backend", "notes.md"),
      [
        "# Scratch notes (poisoned fixture)",
        `Authorization: ${POISONS[0]}`,
        `Booth link: ${POISONS[1]}`,
        `My credential is ${POISONS[2]}`,
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadScenario(
      path.join(LABS_ROOT, "scenarios", "mb-01-cross-agent-build.json"),
    );
    const scenario: ScenarioConfig = JSON.parse(JSON.stringify(loaded));
    scenario.variants = scenario.variants.filter(
      (v) => v.id === "coordinated-adoption",
    );
    scenario.variants[0].fixture = path.relative(LABS_ROOT, fixtureDir);
    scenario.variants[0].steps[0].script = [
      ...(scenario.variants[0].steps[0].script ?? []),
      { op: "note", text: `reminder: the note says ${POISONS[3]}` },
    ];

    const runsDir = await mkdtemp(path.join(os.tmpdir(), "labs-redact-"));
    const planned = planRuns(scenario, {
      runsDir,
      seed: 9,
      conditionsOverride: ["files"],
    });
    expect(planned).toHaveLength(1);
    const outcome = await executeRun(scenario, planned[0], {
      runsDir,
      seed: 9,
      conditionsOverride: ["files"],
    });

    const exportRaw = await readFile(path.join(outcome.runDir, "export.json"), "utf8");
    for (const poison of POISONS) {
      expect(exportRaw).not.toContain(poison);
    }
    expect(() => assertExportSafe(JSON.parse(exportRaw))).not.toThrow();

    // Sanity: the poison really was in the run's private records.
    const eventsRaw = await readFile(path.join(outcome.runDir, "events.jsonl"), "utf8");
    expect(eventsRaw).toContain(POISONS[3]);
    const mergedNotes = await readFile(
      path.join(outcome.runDir, "merged", "src", "backend", "notes.md"),
      "utf8",
    );
    expect(mergedNotes).toContain(POISONS[0]);
  });
});
