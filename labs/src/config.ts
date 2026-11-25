import { readFile } from "node:fs/promises";
import type { ScenarioConfig } from "./types.js";
import { validateScenarioDocument } from "./schema.js";

export class ScenarioValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Scenario validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "ScenarioValidationError";
    this.errors = errors;
  }
}

/** Load and schema-validate a scenario configuration file. */
export async function loadScenario(path: string): Promise<ScenarioConfig> {
  const raw = await readFile(path, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new ScenarioValidationError([
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    ]);
  }
  const errors = validateScenarioDocument(doc);
  if (errors.length > 0) throw new ScenarioValidationError(errors);
  return doc as ScenarioConfig;
}
