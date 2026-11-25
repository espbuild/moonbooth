import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { StructuredError } from "./errors.js";
import {
  SUPPORTED_ACT_VERSIONS,
  manifestSchema,
  receiptSchema,
} from "./schemas.js";

export interface ActManifest {
  act_version: string;
  capability: {
    id: string;
    name: string;
    version: string;
    description: string;
  };
  artifact: {
    format: "agent-skills";
    entrypoint: string;
    digest: string;
  };
  requirements: {
    tools: string[];
    configuration: Array<{
      name: string;
      description?: string;
      required?: boolean;
    }>;
  };
  requested_permissions: {
    network: boolean;
    filesystem_write: boolean;
    external_side_effects: boolean;
  };
  verification: {
    test_manifest: string;
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateManifestFn = ajv.compile(manifestSchema);
const validateReceiptFn = ajv.compile(receiptSchema);

function toStructured(errors: ErrorObject[] | null | undefined): StructuredError[] {
  if (!errors) return [];
  return errors.map((e) => ({
    code:
      e.keyword === "additionalProperties"
        ? "UNKNOWN_FIELD"
        : e.keyword === "required"
          ? "MISSING_FIELD"
          : "SCHEMA_VALIDATION",
    path: e.instancePath || "/",
    keyword: e.keyword,
    message: e.message ?? "schema validation failed",
  }));
}

/**
 * Validate an unknown value as an ACT manifest.
 * Unknown fields are rejected. An act_version other than a supported
 * version fails with the distinct code UNSUPPORTED_ACT_VERSION, checked
 * before schema validation so callers can branch on it.
 */
export function validateManifest(
  input: unknown,
): { ok: true; value: ActManifest } | { ok: false; errors: StructuredError[] } {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const version = (input as Record<string, unknown>).act_version;
    if (
      typeof version === "string" &&
      !(SUPPORTED_ACT_VERSIONS as readonly string[]).includes(version)
    ) {
      return {
        ok: false,
        errors: [
          {
            code: "UNSUPPORTED_ACT_VERSION",
            path: "/act_version",
            keyword: "const",
            message: `unsupported act_version "${version}"; supported: ${SUPPORTED_ACT_VERSIONS.join(", ")}`,
          },
        ],
      };
    }
  }
  if (validateManifestFn(input)) {
    return { ok: true, value: input as ActManifest };
  }
  return { ok: false, errors: toStructured(validateManifestFn.errors) };
}

/** Validate an unknown value against the receipt schema. */
export function validateReceiptShape(
  input: unknown,
): { ok: true } | { ok: false; errors: StructuredError[] } {
  if (validateReceiptFn(input)) return { ok: true };
  return { ok: false, errors: toStructured(validateReceiptFn.errors) };
}
