import { describe, expect, it } from "vitest";
import { buildPackage, validateManifest } from "../src/index.js";
import { goodFiles, manifestInput } from "./helpers.js";

function validManifestJson(): Record<string, unknown> {
  const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
  return pkg.manifest as unknown as Record<string, unknown>;
}

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateManifest(validManifestJson());
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    const result = validateManifest({ ...validManifestJson(), extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNKNOWN_FIELD")).toBe(true);
      expect(result.errors[0].path).toBeDefined();
      expect(result.errors[0].keyword).toBe("additionalProperties");
    }
  });

  it("rejects an unknown nested field", () => {
    const m = validManifestJson();
    (m.capability as Record<string, unknown>).extra = "x";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNKNOWN_FIELD")).toBe(true);
    }
  });

  it("rejects a missing required field", () => {
    const m = validManifestJson();
    delete m.verification;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "MISSING_FIELD")).toBe(true);
    }
  });

  it("rejects a bad semver", () => {
    const m = validManifestJson();
    (m.capability as Record<string, unknown>).version = "1.0";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
  });

  it("rejects a bad capability slug", () => {
    const m = validManifestJson();
    (m.capability as Record<string, unknown>).id = "Bad Slug!";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("rejects a non-boolean permission", () => {
    const m = validManifestJson();
    (m.requested_permissions as Record<string, unknown>).network = "yes";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("rejects an unsupported act_version with a distinct code", () => {
    const m = validManifestJson();
    m.act_version = "0.2";
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("UNSUPPORTED_ACT_VERSION");
      expect(result.errors[0].path).toBe("/act_version");
    }
  });

  it("rejects a malformed digest", () => {
    const m = validManifestJson();
    (m.artifact as Record<string, unknown>).digest = "not-hex";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest("x").ok).toBe(false);
    expect(validateManifest([1]).ok).toBe(false);
  });
});
