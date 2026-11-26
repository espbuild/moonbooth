import { readFile } from "node:fs/promises";
import type { ScenarioConfig } from "./types.js";
import { validateScenarioDocument } from "./schema.js";
import type { GameScenarioConfig } from "./games/types.js";
import { validateGameScenarioDocument } from "./games/schema.js";

export class ScenarioValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Scenario validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "ScenarioValidationError";
    this.errors = errors;
  }
}

async function readScenarioJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ScenarioValidationError([
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    ]);
  }
}

/** Load and schema-validate a scenario configuration file. */
export async function loadScenario(path: string): Promise<ScenarioConfig> {
  const doc = await readScenarioJson(path);
  const errors = validateScenarioDocument(doc);
  if (errors.length > 0) throw new ScenarioValidationError(errors);
  return doc as ScenarioConfig;
}

/**
 * Load and validate a gamebook game scenario (a document carrying a
 * `game` block). Game scenarios validate against the game schema in
 * games/schema.ts; the base scenario schema cannot carry them.
 */
export async function loadGameScenario(path: string): Promise<GameScenarioConfig> {
  const doc = await readScenarioJson(path);
  const errors = validateGameScenarioDocument(doc);
  if (errors.length > 0) throw new ScenarioValidationError(errors);
  return doc as GameScenarioConfig;
}

/** True when a parsed scenario document is a game scenario. */
export function isGameScenarioDocument(doc: unknown): boolean {
  return (
    typeof doc === "object" &&
    doc !== null &&
    "game" in (doc as Record<string, unknown>)
  );
}
