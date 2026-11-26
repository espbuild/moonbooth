// Game scenario validation: a JSON Schema for the gamebook game
// shape, checked with the same small validator the base scenario
// schema uses (../schema.ts). The differences from the base schema
// are exactly the format gaps the gamebook adoption records: game
// conditions (transcript / moonbooth / moonbooth-ablated) instead of
// workspace channels, roles without an owned area, variants without
// a fixture, steps that name a seat and carry telephone stub ops,
// injections that may carry a question instead of files, and the two
// extra top-level blocks, `game` and `seedRequirements`.

import { validateNode, type SchemaNode } from "../schema.js";

export const GAME_SCENARIO_SCHEMA = {
  $id: "moonbooth-labs/game-scenario",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "slug",
    "version",
    "objective",
    "roles",
    "runtimes",
    "conditions",
    "budget",
    "stopRule",
    "variants",
    "injections",
    "checks",
    "knownLimitations",
    "seedRequirements",
    "game",
  ],
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    version: { type: "string" },
    objective: { type: "string" },
    hypothesis: { type: "string" },
    primaryMetric: { type: "string" },
    roles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "brief"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          brief: { type: "string" },
        },
      },
    },
    runtimes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "adapter"],
        properties: {
          id: { type: "string" },
          adapter: { type: "string", enum: ["stub", "codex", "api-session"] },
          model: { type: "string" },
          options: { type: "object" },
        },
      },
    },
    conditions: {
      type: "array",
      items: {
        type: "string",
        enum: ["transcript", "moonbooth", "moonbooth-ablated"],
      },
    },
    moonbooth: {
      type: "object",
      additionalProperties: false,
      required: ["apiBaseUrl"],
      properties: { apiBaseUrl: { type: "string" } },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      required: [
        "maxWallTimeSecondsPerRun",
        "maxCostUsdPerRun",
        "maxInterventionsPerRun",
      ],
      properties: {
        maxWallTimeSecondsPerRun: { type: "number", minimum: 1 },
        maxCostUsdPerRun: { type: ["number", "null"], minimum: 0 },
        maxInterventionsPerRun: { type: "number", minimum: 0 },
      },
    },
    stopRule: { type: "string" },
    variants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "steps"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["role", "seat"],
              properties: {
                role: { type: "string" },
                seat: { type: "number", minimum: 1 },
                script: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["op"],
                    properties: {
                      op: { type: "string", enum: ["restateSpec", "answerProbe"] },
                      drop: { type: "array", items: { type: "string" } },
                      distort: { type: "array", items: { type: "string" } },
                      only: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    injections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "beforeStepIndex", "description"],
        properties: {
          id: { type: "string" },
          beforeStepIndex: { type: "number", minimum: 0 },
          description: { type: "string" },
          question: { type: "string" },
        },
      },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "description"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["command", "fileExists", "fileContains"] },
          description: { type: "string" },
          command: { type: "string" },
          path: { type: "string" },
          contains: { type: "string" },
          weight: { type: "number", minimum: 0 },
          partialFromOutput: { type: "boolean" },
          detectsMissedChange: { type: "string" },
        },
      },
    },
    knownLimitations: { type: "array", items: { type: "string" } },
    seedRequirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "statement"],
        properties: {
          id: { type: "string" },
          statement: { type: "string" },
        },
      },
    },
    game: {
      type: "object",
      additionalProperties: false,
      required: ["players", "driver", "win_condition", "scoring"],
      properties: {
        players: {
          type: "object",
          additionalProperties: false,
          required: ["count", "role", "assignment"],
          properties: {
            count: { type: "number", minimum: 1 },
            role: { type: "string" },
            assignment: { type: "string" },
          },
        },
        driver: {
          type: "object",
          additionalProperties: false,
          required: ["events"],
          properties: {
            events: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "trigger", "deliver"],
                properties: {
                  id: { type: "string" },
                  trigger: { type: "string" },
                  deliver: { type: "string" },
                },
              },
            },
          },
        },
        win_condition: { type: "string" },
        scoring: {
          type: "object",
          additionalProperties: false,
          required: ["type", "definition", "primary"],
          properties: {
            type: { type: "string" },
            definition: { type: "string" },
            primary: { type: "string" },
            partial_credit: { type: "string" },
          },
        },
        conditions_map: { type: "object" },
        registry: {
          type: "object",
          additionalProperties: false,
          required: ["experiment", "spec"],
          properties: {
            experiment: { type: "string" },
            spec: { type: "string" },
          },
        },
      },
    },
  },
} as const;

/** Validate a parsed JSON document against the game scenario schema. */
export function validateGameScenarioDocument(doc: unknown): string[] {
  const errors: string[] = [];
  validateNode(doc, GAME_SCENARIO_SCHEMA as unknown as SchemaNode, "$", errors);
  if (errors.length === 0 && typeof doc === "object" && doc !== null) {
    // Cross-field checks the schema subset cannot express.
    const s = doc as {
      roles: { id: string }[];
      game: { players: { count: number; role: string } };
      seedRequirements: { id: string }[];
      variants: { id: string; steps: { role: string; seat: number }[] }[];
      injections: { id: string }[];
      checks: { id: string }[];
    };
    const roleIds = new Set(s.roles.map((r) => r.id));
    if (!roleIds.has(s.game.players.role)) {
      errors.push(`$.game.players: unknown role "${s.game.players.role}"`);
    }
    const seedIds = new Set<string>();
    s.seedRequirements.forEach((r, i) => {
      if (seedIds.has(r.id)) {
        errors.push(`$.seedRequirements[${i}]: duplicate requirement id "${r.id}"`);
      }
      seedIds.add(r.id);
    });
    s.variants.forEach((v, vi) => {
      const seats = new Set<number>();
      v.steps.forEach((step, si) => {
        if (!roleIds.has(step.role)) {
          errors.push(`$.variants[${vi}].steps[${si}]: unknown role "${step.role}"`);
        }
        if (seats.has(step.seat)) {
          errors.push(`$.variants[${vi}].steps[${si}]: duplicate seat ${step.seat}`);
        }
        seats.add(step.seat);
      });
      if (v.steps.length !== s.game.players.count) {
        errors.push(
          `$.variants[${vi}]: ${v.steps.length} step(s) for ${s.game.players.count} seat(s)`,
        );
      }
    });
    const checkIds = new Set<string>();
    s.checks.forEach((c, ci) => {
      if (checkIds.has(c.id)) errors.push(`$.checks[${ci}]: duplicate check id "${c.id}"`);
      checkIds.add(c.id);
    });
    const injectionIds = new Set<string>();
    s.injections.forEach((inj, ii) => {
      if (injectionIds.has(inj.id)) {
        errors.push(`$.injections[${ii}]: duplicate injection id "${inj.id}"`);
      }
      injectionIds.add(inj.id);
    });
  }
  return errors;
}
