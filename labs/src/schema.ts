// Scenario configuration: JSON Schema plus a small validator for the
// subset of JSON Schema the scenario schema uses (type, required,
// properties, items, enum, minimum, additionalProperties). Validation
// errors are returned as a list of human-readable strings; an empty
// list means the document conforms.

export const SCENARIO_SCHEMA = {
  $id: "moonbooth-labs/scenario",
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
        required: ["id", "title", "area", "brief"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          area: { type: "string" },
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
      items: { type: "string", enum: ["files", "git", "moonbooth"] },
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
        required: ["id", "description", "fixture", "steps"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          fixture: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["role"],
              properties: {
                role: { type: "string" },
                syncIn: { type: "boolean" },
                syncOut: { type: "boolean" },
                brief: { type: "string" },
                script: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["op"],
                    properties: {
                      op: {
                        type: "string",
                        enum: [
                          "writeServiceFromContract",
                          "writeClientFromContract",
                          "writeFile",
                          "appendFile",
                          "note",
                        ],
                      },
                      target: { type: "string" },
                      path: { type: "string" },
                      content: { type: "string" },
                      text: { type: "string" },
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
        required: ["id", "beforeStepIndex", "description", "files"],
        properties: {
          id: { type: "string" },
          beforeStepIndex: { type: "number", minimum: 0 },
          description: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "content"],
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
            },
          },
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
  },
} as const;

type SchemaNode = {
  type?: string | string[];
  required?: readonly string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: readonly unknown[];
  minimum?: number;
  additionalProperties?: boolean;
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateNode(
  value: unknown,
  schema: SchemaNode,
  path: string,
  errors: string[],
): void {
  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push(`${path}: expected one of ${schema.enum.join(", ")}, got ${JSON.stringify(value)}`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual)) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${actual}`);
      return;
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: unexpected property "${key}"`);
        }
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) validateNode(obj[key], sub, `${path}.${key}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateNode(item, schema.items!, `${path}[${i}]`, errors));
  }
}

/** Validate a parsed JSON document against the scenario schema. */
export function validateScenarioDocument(doc: unknown): string[] {
  const errors: string[] = [];
  validateNode(doc, SCENARIO_SCHEMA as unknown as SchemaNode, "$", errors);
  if (errors.length === 0 && typeOf(doc) === "object") {
    // Cross-field checks the schema subset cannot express.
    const s = doc as {
      roles: { id: string }[];
      variants: { steps: { role: string }[] }[];
      injections: { id: string }[];
      checks: { id: string; detectsMissedChange?: string }[];
    };
    const roleIds = new Set(s.roles.map((r) => r.id));
    s.variants.forEach((v, vi) => {
      v.steps.forEach((step, si) => {
        if (!roleIds.has(step.role)) {
          errors.push(`$.variants[${vi}].steps[${si}]: unknown role "${step.role}"`);
        }
      });
    });
    const injectionIds = new Set(s.injections.map((i) => i.id));
    s.checks.forEach((c, ci) => {
      if (c.detectsMissedChange && !injectionIds.has(c.detectsMissedChange)) {
        errors.push(
          `$.checks[${ci}]: detectsMissedChange references unknown injection "${c.detectsMissedChange}"`,
        );
      }
    });
    const checkIds = new Set<string>();
    s.checks.forEach((c, ci) => {
      if (checkIds.has(c.id)) errors.push(`$.checks[${ci}]: duplicate check id "${c.id}"`);
      checkIds.add(c.id);
    });
  }
  return errors;
}
