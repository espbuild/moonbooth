import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadScenario } from "../src/config.js";
import { LABS_ROOT, runScenario, type RunOutcome } from "../src/engine.js";
import { assertExportSafe, type RunManifest } from "../src/manifest.js";
import { startBoothDouble, type BoothDouble } from "./helpers/booth-double.js";

// End-to-end dry run: the full MB-01 campaign with the stub adapter
// across all three conditions. The moonbooth condition runs against a
// local API double (tests/helpers/booth-double.ts) so the SDK-over-
// HTTP path is exercised without a live service. Expected outcomes are
// determined by each variant's script, per the scenario file:
// coordinated-adoption passes outright; missed-change and
// interface-drift fail with exactly one missed change each.

let double: BoothDouble;
let outcomes: RunOutcome[];

beforeAll(async () => {
  double = await startBoothDouble();
  const scenario = await loadScenario(
    path.join(LABS_ROOT, "scenarios", "mb-01-cross-agent-build.json"),
  );
  const runsDir = await mkdtemp(path.join(os.tmpdir(), "labs-e2e-"));
  outcomes = await runScenario(scenario, {
    runsDir,
    seed: 11,
    adapterOverride: "stub",
    moonboothApiBaseUrl: double.baseUrl,
  });
}, 300_000);

afterAll(async () => {
  await double.close();
});

function byVariantAndCondition(): Map<string, RunManifest> {
  const map = new Map<string, RunManifest>();
  for (const o of outcomes) map.set(`${o.manifest.variantId}:${o.manifest.condition}`, o.manifest);
  return map;
}

describe("MB-01 dry run across all three conditions", () => {
  it("produces nine runs: three variants under three conditions", () => {
    expect(outcomes).toHaveLength(9);
    const map = byVariantAndCondition();
    for (const variant of ["coordinated-adoption", "missed-change", "interface-drift"]) {
      for (const condition of ["files", "git", "moonbooth"]) {
        expect(map.has(`${variant}:${condition}`)).toBe(true);
      }
    }
  });

  it("coordinated-adoption passes everywhere with no missed changes", () => {
    const map = byVariantAndCondition();
    for (const condition of ["files", "git", "moonbooth"]) {
      const m = map.get(`coordinated-adoption:${condition}`)!;
      expect(m.outcome.status).toBe("passed");
      expect(m.outcome.score).toBe(1);
      expect(m.metrics.missedChanges).toBe(0);
      expect(m.failureCategory).toBeNull();
    }
  });

  it("missed-change fails on adoption only, with the roundtrip intact", () => {
    const map = byVariantAndCondition();
    for (const condition of ["files", "git", "moonbooth"]) {
      const m = map.get(`missed-change:${condition}`)!;
      expect(m.outcome.status).toBe("failed");
      expect(m.metrics.missedChanges).toBe(1);
      expect(m.metrics.missedChangeInjections).toEqual(["inj-pagination-v2"]);
      const suite = m.outcome.checks.find((c) => c.id === "integration-suite")!;
      // service/client adoption assertions fail; roundtrip and dataset pass.
      expect(suite.score).toBe(0.5);
      const adoption = m.outcome.checks.find((c) => c.id === "contract-adoption")!;
      expect(adoption.passed).toBe(false);
    }
  });

  it("interface-drift fails with drift between client and service", () => {
    const map = byVariantAndCondition();
    for (const condition of ["files", "git", "moonbooth"]) {
      const m = map.get(`interface-drift:${condition}`)!;
      expect(m.outcome.status).toBe("failed");
      expect(m.metrics.missedChanges).toBe(1);
      const suite = m.outcome.checks.find((c) => c.id === "integration-suite")!;
      // Client adopted v2; service stayed v1; roundtrip broken.
      expect(suite.score).toBe(0.5);
    }
  });

  it("every run writes a manifest and a safe export that names the stub limitation", async () => {
    for (const o of outcomes) {
      const manifestRaw = await readFile(path.join(o.runDir, "manifest.json"), "utf8");
      expect(JSON.parse(manifestRaw).runId).toBe(o.runId);
      const exportRaw = await readFile(path.join(o.runDir, "export.json"), "utf8");
      const parsed = JSON.parse(exportRaw) as { knownLimitations: string[] };
      expect(() => assertExportSafe(parsed)).not.toThrow();
      expect(
        parsed.knownLimitations.some((l) => l.includes("deterministic stub adapter")),
      ).toBe(true);
      // No booth URL or credential from the double leaks into an export.
      expect(exportRaw).not.toContain("creator-credential");
      expect(exportRaw).not.toContain("participant-credential");
      expect(exportRaw).not.toContain("/b/booth-double");
    }
  });
});
