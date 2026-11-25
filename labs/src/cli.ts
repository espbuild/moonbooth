#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadScenario, ScenarioValidationError } from "./config.js";
import { LABS_ROOT, harnessVersion, runScenario } from "./engine.js";
import { assertExportSafe, buildExport, type RunManifest } from "./manifest.js";
import type { HarnessEvent } from "./types.js";

// Moonbooth Labs harness CLI.
//
//   labs validate <scenario.json>
//   labs run <scenario.json> [--condition files|git|moonbooth]
//        [--adapter stub|codex|api-session] [--seed N]
//        [--budget-cap SECONDS] [--runs-dir DIR]
//        [--interventions FILE] [--dry-run]
//   labs export <run-dir> [--out FILE]
//
// --dry-run forces the stub adapter across every condition in the
// scenario: the full pipeline at zero model cost. A run's outcome
// (passed/failed checks) is data, not a CLI failure; the CLI exits
// non-zero only when a run errors before evaluation or inputs are bad.

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function cmdValidate(scenarioPath: string): Promise<number> {
  try {
    const scenario = await loadScenario(scenarioPath);
    console.log(
      `Valid: ${scenario.id} (${scenario.slug}) v${scenario.version} — ` +
        `${scenario.variants.length} variant(s), ${scenario.conditions.length} condition(s), ` +
        `${scenario.checks.length} check(s), ${scenario.injections.length} injection(s).`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ScenarioValidationError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

async function cmdRun(scenarioPath: string, args: string[]): Promise<number> {
  const scenario = await loadScenario(scenarioPath);
  const dryRun = hasFlag(args, "--dry-run");
  const adapterFlag = flagValue(args, "--adapter");
  const conditionFlag = flagValue(args, "--condition");
  const seedRaw = flagValue(args, "--seed");
  const budgetCapRaw = flagValue(args, "--budget-cap");
  const runsDir = path.resolve(
    flagValue(args, "--runs-dir") ?? path.join(LABS_ROOT, "runs"),
  );
  const outcomes = await runScenario(scenario, {
    runsDir,
    seed: seedRaw !== undefined ? (Number.isNaN(Number(seedRaw)) ? seedRaw : Number(seedRaw)) : 1,
    adapterOverride: dryRun
      ? "stub"
      : (adapterFlag as "stub" | "codex" | "api-session" | undefined),
    conditionsOverride: conditionFlag
      ? [conditionFlag as "files" | "git" | "moonbooth"]
      : undefined,
    budgetCapSeconds: budgetCapRaw !== undefined ? Number(budgetCapRaw) : undefined,
    interventionsFile: flagValue(args, "--interventions"),
    // Operator override for the moonbooth condition's API base URL
    // (e.g. a local test double). Defaults to the scenario's value.
    moonboothApiBaseUrl: process.env.MOONBOOTH_LABS_API_URL,
  });
  let anyError = false;
  for (const outcome of outcomes) {
    const m = outcome.manifest;
    if (m.outcome.status === "error") anyError = true;
    console.log(
      `${m.runId}: ${m.outcome.status} (score ${m.outcome.score.toFixed(2)}, ` +
        `missed changes ${m.metrics.missedChanges}, rework ${m.metrics.reworkEvents}, ` +
        `interventions ${m.metrics.interventions}, wall ${m.wallTimeSeconds}s)`,
    );
    console.log(`  manifest: ${path.join(outcome.runDir, "manifest.json")}`);
    console.log(`  export:   ${path.join(outcome.runDir, "export.json")}`);
  }
  return anyError ? 2 : 0;
}

async function cmdExport(runDirArg: string, args: string[]): Promise<number> {
  const runDir = path.resolve(runDirArg);
  const out = path.resolve(flagValue(args, "--out") ?? path.join(runDir, "export.json"));
  const existingPath = path.join(runDir, "export.json");
  const existingRaw = await readFile(existingPath, "utf8").catch(() => null);

  if (!hasFlag(args, "--rebuild")) {
    // Default: verify the export the engine wrote at run time (it
    // carries the full limitations) and copy it to --out if asked.
    if (existingRaw === null) {
      throw new Error(
        `No export.json in ${runDir}. Rebuild it with: labs export ${runDirArg} --rebuild --scenario <scenario.json>`,
      );
    }
    const existing = JSON.parse(existingRaw) as unknown;
    assertExportSafe(existing);
    if (out !== existingPath) {
      await writeFile(out, existingRaw, "utf8");
    }
    console.log(`Export verified: ${out}`);
    return 0;
  }

  const scenarioPath = flagValue(args, "--scenario");
  if (!scenarioPath) {
    throw new Error("--rebuild requires --scenario <scenario.json>.");
  }
  const scenario = await loadScenario(scenarioPath);
  const manifest = JSON.parse(
    await readFile(path.join(runDir, "manifest.json"), "utf8"),
  ) as RunManifest;
  const eventsRaw = await readFile(path.join(runDir, "events.jsonl"), "utf8");
  const events = eventsRaw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as HarnessEvent);
  // Preserve the original export's limitations (scenario + adapter)
  // when one exists; a rebuild regenerates metrics and timeline.
  let limitations = scenario.knownLimitations;
  if (existingRaw !== null) {
    const existing = JSON.parse(existingRaw) as { knownLimitations?: string[] };
    if (Array.isArray(existing.knownLimitations)) limitations = existing.knownLimitations;
  }
  const exportObj = buildExport({
    manifest,
    events,
    scenarioLimitations: limitations,
    adapterLimitations: [],
    moonboothApiBaseUrl: scenario.moonbooth?.apiBaseUrl,
    harnessVersion: await harnessVersion(),
  });
  await writeFile(out, JSON.stringify(exportObj, null, 2) + "\n", "utf8");
  console.log(`Export rebuilt: ${out}`);
  return 0;
}

async function main(): Promise<number> {
  const [command, target, ...rest] = process.argv.slice(2);
  switch (command) {
    case "validate":
      if (!target) throw new Error("Usage: labs validate <scenario.json>");
      return cmdValidate(path.resolve(target));
    case "run":
      if (!target) throw new Error("Usage: labs run <scenario.json> [flags]");
      return cmdRun(path.resolve(target), rest);
    case "export":
      if (!target) throw new Error("Usage: labs export <run-dir> [--out FILE]");
      return cmdExport(target, rest);
    default:
      console.error(
        "Usage: labs <validate|run|export> ...\n" +
          "  labs validate <scenario.json>\n" +
          "  labs run <scenario.json> [--condition C] [--adapter A] [--seed N] [--budget-cap S] [--runs-dir D] [--interventions F] [--dry-run]\n" +
          "  labs export <run-dir> [--out FILE] [--scenario <scenario.json>]",
      );
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
