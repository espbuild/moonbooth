#!/usr/bin/env node
// Standalone telephone-game drift scorer: the command surface the
// MB-09 scenario's checks name. It scores the restatement artifacts
// of a game run directory with the same implementation the game
// runner uses in-process (src/games/scorer.ts, compiled to
// dist/games/scorer.js — run `npm run build` first).
//
// Usage:
//   node scorers/telephone-drift.mjs --run-dir DIR [--scenario PATH]
//       (--position N | --positions all | --probe stakeholder-question)
//
// --scenario defaults to scenarios/mb-09-agent-telephone-game.json.
// Output: one "ok"/"not ok" line per requirement (TAP-style, as the
// scenario's partial-credit checks expect), plus the fidelity figure.
// The fidelity line is authoritative; a 0.5-scored requirement prints
// "ok ... (partial 0.5)" because TAP has no half line.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreChain, scoreProbeAnswer, scoreRestatement } from "../dist/games/scorer.js";

const LABS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const runDir = flagValue(args, "--run-dir");
  if (!runDir) {
    console.error("Usage: telephone-drift.mjs --run-dir DIR [--scenario PATH] (--position N | --positions all | --probe stakeholder-question)");
    process.exitCode = 1;
    return;
  }
  const scenarioPath = path.resolve(
    flagValue(args, "--scenario") ?? path.join(LABS_ROOT, "scenarios", "mb-09-agent-telephone-game.json"),
  );
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  const seed = scenario.seedRequirements;
  const restatementsRaw = JSON.parse(await readFile(path.join(runDir, "restatements.json"), "utf8"));
  const restatements = restatementsRaw.map((r) => r.entries);

  const positionRaw = flagValue(args, "--position");
  const probe = flagValue(args, "--probe");
  if (probe !== undefined) {
    const probeData = JSON.parse(await readFile(path.join(runDir, "probe.json"), "utf8"));
    const result = scoreProbeAnswer(probeData.answer);
    console.log(`${result.correct ? "ok" : "not ok"} probe ${probe} — ${result.detail}`);
    console.log(`probe correct: ${result.correct}`);
    return;
  }
  if (args.includes("--positions")) {
    const chain = scoreChain(seed, restatements);
    for (const pos of chain.positions) {
      console.log(
        `position ${pos.position}: fidelity ${pos.fidelity} (omissions ${pos.omissions}, distortions ${pos.distortions}, contradictions ${pos.contradictions})`,
      );
    }
    console.log(`end fidelity: ${chain.endFidelity}`);
    return;
  }
  if (positionRaw !== undefined) {
    const position = Number(positionRaw);
    const scored = scoreRestatement(seed, restatements[position - 1] ?? []);
    for (const s of scored.scores) {
      const partial = s.score === 0.5 ? " (partial 0.5)" : "";
      console.log(`${s.score > 0 ? "ok" : "not ok"} ${s.id}${partial} — ${s.detail}`);
    }
    console.log(`fidelity: ${scored.fidelity}`);
    return;
  }
  console.error("Nothing to score: pass --position N, --positions all, or --probe stakeholder-question.");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
