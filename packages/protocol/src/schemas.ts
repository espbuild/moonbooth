/**
 * Canonical JSON Schemas for ACT 0.1.
 *
 * These objects are the source of truth for the TypeScript package.
 * The published copies at spec/schemas/*.json are generated from these
 * objects (scripts/emit-schemas.mjs) and a conformance test asserts the
 * two forms stay identical.
 */

export const SUPPORTED_ACT_VERSIONS = ["0.1"] as const;
export const ACT_VERSION = "0.1";
export const RECEIPT_VERSION = "0.1";

/** Result labels a receipt may carry. Wording is fixed by the spec. */
export const RESULT_LABELS = [
  "VALIDATED",
  "POLICY_CHECKS_PASSED",
  "TESTED",
  "VERIFIED_FOR_TEST_SUITE",
  "INSUFFICIENT_EVIDENCE",
  "FAILED",
  "NOT_TESTED",
] as const;
export type ResultLabel = (typeof RESULT_LABELS)[number];

const SEMVER_PATTERN =
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$";

const SLUG_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const SHA256_PATTERN = "^[a-f0-9]{64}$";

export const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://act-protocol.example/spec/0.1/act-manifest.schema.json",
  title: "ACT Manifest",
  description:
    "The act.json file that sits beside a SKILL.md in an ACT package.",
  type: "object",
  additionalProperties: false,
  required: [
    "act_version",
    "capability",
    "artifact",
    "requirements",
    "requested_permissions",
    "verification",
  ],
  properties: {
    act_version: {
      type: "string",
      const: ACT_VERSION,
      description: "ACT protocol version this manifest targets.",
    },
    capability: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "version", "description"],
      properties: {
        id: {
          type: "string",
          pattern: SLUG_PATTERN,
          minLength: 1,
          maxLength: 128,
          description: "Stable slug that identifies the capability.",
        },
        name: { type: "string", minLength: 1, maxLength: 200 },
        version: {
          type: "string",
          pattern: SEMVER_PATTERN,
          description: "Semantic version of the capability.",
        },
        description: { type: "string", minLength: 1, maxLength: 2000 },
      },
    },
    artifact: {
      type: "object",
      additionalProperties: false,
      required: ["format", "entrypoint", "digest"],
      properties: {
        format: { type: "string", const: "agent-skills" },
        entrypoint: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Package-relative POSIX path of the entrypoint file, normally SKILL.md.",
        },
        digest: {
          type: "string",
          pattern: SHA256_PATTERN,
          description:
            "Lowercase hex SHA-256 package digest. See spec section 6.",
        },
      },
    },
    requirements: {
      type: "object",
      additionalProperties: false,
      required: ["tools", "configuration"],
      properties: {
        tools: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 128 },
          uniqueItems: true,
        },
        configuration: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 128 },
              description: { type: "string", maxLength: 1000 },
              required: { type: "boolean" },
            },
          },
        },
      },
    },
    requested_permissions: {
      type: "object",
      additionalProperties: false,
      required: ["network", "filesystem_write", "external_side_effects"],
      properties: {
        network: { type: "boolean" },
        filesystem_write: { type: "boolean" },
        external_side_effects: { type: "boolean" },
      },
    },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["test_manifest"],
      properties: {
        test_manifest: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Package-relative POSIX path of the test manifest file.",
        },
      },
    },
  },
} as const;

const resultLabel = { type: "string", enum: [...RESULT_LABELS] };

export const receiptSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://act-protocol.example/spec/0.1/act-receipt.schema.json",
  title: "ACT Verification Receipt",
  description:
    "Record of one verification run against one transferred package.",
  type: "object",
  additionalProperties: false,
  required: [
    "receipt_version",
    "transfer_id",
    "capability",
    "artifact_digest",
    "timestamp",
    "environment",
    "structural_result",
    "security_result",
    "compatibility_result",
    "behavioral_outcomes",
    "test_suite",
    "evidence_references",
    "baseline_comparison",
    "missing_checks",
    "unsupported_checks",
    "human_approval_status",
    "adoption_status",
  ],
  properties: {
    receipt_version: { type: "string", const: RECEIPT_VERSION },
    transfer_id: { type: "string", minLength: 1, maxLength: 256 },
    capability: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version"],
      properties: {
        id: { type: "string", pattern: SLUG_PATTERN, minLength: 1 },
        version: { type: "string", pattern: SEMVER_PATTERN },
      },
    },
    artifact_digest: { type: "string", pattern: SHA256_PATTERN },
    timestamp: { type: "string", format: "date-time" },
    environment: {
      type: "object",
      additionalProperties: false,
      required: ["adapter_id"],
      properties: {
        adapter_id: { type: "string", minLength: 1, maxLength: 256 },
        description: { type: "string", maxLength: 1000 },
      },
    },
    structural_result: resultLabel,
    security_result: resultLabel,
    compatibility_result: resultLabel,
    behavioral_outcomes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["test_id", "result"],
        properties: {
          test_id: { type: "string", minLength: 1, maxLength: 256 },
          result: resultLabel,
          notes: { type: "string", maxLength: 2000 },
        },
      },
    },
    test_suite: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 256 },
        version: { type: "string", pattern: SEMVER_PATTERN },
      },
    },
    evidence_references: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 1024 },
    },
    baseline_comparison: {
      type: "object",
      additionalProperties: false,
      required: ["performed"],
      properties: {
        performed: { type: "boolean" },
        result: { type: ["string", "null"], enum: [...RESULT_LABELS, null] },
        summary: { type: "string", maxLength: 2000 },
      },
    },
    missing_checks: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
    unsupported_checks: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
    human_approval_status: {
      type: "string",
      enum: ["APPROVED", "REJECTED", "PENDING", "NOT_REQUIRED"],
    },
    adoption_status: {
      type: "string",
      enum: ["ADOPTED", "NOT_ADOPTED", "PENDING"],
    },
  },
} as const;
