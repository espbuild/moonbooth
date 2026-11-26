// Types for Labs game scenarios — the gamebook games (docs/gamebook.md
// in the private espetey/act repo; the canon list and canon rules live
// there). A game scenario is a sibling of the build ScenarioConfig, not
// a subtype: the base scenario format cannot carry a game. Its
// conditions are handoff channels for a seat chain (transcript /
// moonbooth / moonbooth-ablated), its roles have no owned code area,
// its variants have no fixture directory, and it carries two blocks
// the base format has no place for — `game` and `seedRequirements`.
// The game schema (./schema.ts) validates this shape; the base
// validator in ../schema.ts rejects these documents, which is the
// format gap the gamebook adoption records.

import type { BudgetCaps, CheckDef, RuntimeDef } from "../types.js";

/** The game's conditions, mapped to the gamebook's B / C / D arms. */
export type GameConditionKind = "transcript" | "moonbooth" | "moonbooth-ablated";

export const GAME_CONDITION_LETTERS: Record<GameConditionKind, string> = {
  transcript: "B",
  moonbooth: "C",
  "moonbooth-ablated": "D",
};

/** One requirement as a seat restates it: an id and a statement. */
export interface RequirementEntry {
  id: string;
  statement: string;
}

/**
 * Scripted operations for the stub adapter in a telephone-game step.
 * `restateSpec` restates the spec exactly as received, with optional
 * scripted damage: `drop` removes requirements, `distort` alters a
 * consequential fact in each named requirement, `only` keeps just the
 * named requirements (a truncated restatement). `answerProbe` answers
 * the driver injection's question from the spec as received.
 */
export type TelephoneStubOp =
  | { op: "restateSpec"; drop?: string[]; distort?: string[]; only?: string[] }
  | { op: "answerProbe" };

export interface GameStepDef {
  role: string;
  /** Chain position, 1-based. One step per seat in each variant. */
  seat: number;
  script?: TelephoneStubOp[];
}

export interface GameVariantDef {
  id: string;
  description: string;
  steps: GameStepDef[];
}

export interface GameInjectionDef {
  id: string;
  /** Delivered by the driver immediately before this step index (0-based). */
  beforeStepIndex: number;
  description: string;
  /** A question put to the seat at that step (the stakeholder probe). */
  question?: string;
}

export interface GameBlock {
  players: { count: number; role: string; assignment: string };
  driver: { events: { id: string; trigger: string; deliver: string }[] };
  win_condition: string;
  scoring: {
    type: string;
    definition: string;
    primary: string;
    partial_credit?: string;
  };
  conditions_map: Record<string, string>;
  registry: { experiment: string; spec: string };
}

export interface GameRoleDef {
  id: string;
  title: string;
  brief: string;
}

export interface GameScenarioConfig {
  id: string;
  slug: string;
  /** Scenario (protocol) version, recorded in every run record. */
  version: string;
  objective: string;
  hypothesis?: string;
  primaryMetric?: string;
  roles: GameRoleDef[];
  runtimes: RuntimeDef[];
  conditions: GameConditionKind[];
  moonbooth?: { apiBaseUrl: string };
  budget: BudgetCaps;
  stopRule: string;
  variants: GameVariantDef[];
  injections: GameInjectionDef[];
  checks: CheckDef[];
  knownLimitations: string[];
  /** The hidden seed spec the chain starts from and is scored against. */
  seedRequirements: RequirementEntry[];
  game: GameBlock;
}
