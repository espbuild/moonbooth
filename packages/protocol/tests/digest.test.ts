import { describe, expect, it } from "vitest";
import {
  buildPackage,
  canonicalDigestInput,
  computePackageDigest,
  sha256Hex,
  validatePackage,
} from "../src/index.js";
import { goodFiles, manifestInput } from "./helpers.js";

describe("package digest", () => {
  it("is deterministic across input order", () => {
    const forward = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const reversed: Record<string, string> = {};
    for (const key of Object.keys(goodFiles).reverse()) {
      reversed[key] = goodFiles[key];
    }
    const backward = buildPackage({ manifest: manifestInput(), files: reversed });
    const viaMap = buildPackage({
      manifest: manifestInput(),
      files: new Map(Object.entries(goodFiles).reverse()),
    });
    expect(backward.digest).toBe(forward.digest);
    expect(viaMap.digest).toBe(forward.digest);
  });

  it("changes when one byte of one file changes", () => {
    const a = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const b = buildPackage({
      manifest: manifestInput(),
      files: { ...goodFiles, "SKILL.md": goodFiles["SKILL.md"] + " " },
    });
    expect(b.digest).not.toBe(a.digest);
  });

  it("changes when a manifest field other than the digest changes", () => {
    const a = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const b = buildPackage({
      manifest: manifestInput({
        capability: {
          id: "sample-capability",
          name: "Renamed Capability",
          version: "1.0.0",
          description: "A sample capability used in tests.",
        },
      }),
      files: goodFiles,
    });
    expect(b.digest).not.toBe(a.digest);
  });

  it("detects tampering after build", () => {
    const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const tampered = pkg.files
      .filter((f) => f.path !== "act.json")
      .map((f) =>
        f.path === "SKILL.md"
          ? { ...f, content: new TextEncoder().encode("# Sample\n\nDo something else.\n") }
          : f,
      );
    const result = validatePackage({ manifest: pkg.manifest, files: tampered });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "DIGEST_MISMATCH")).toBe(true);
  });

  it("canonical input is sorted path lines", () => {
    const input = canonicalDigestInput([
      { path: "b.md", sha256: sha256Hex("b") },
      { path: "a.md", sha256: sha256Hex("a") },
    ]);
    expect(input).toBe(`a.md ${sha256Hex("a")}\nb.md ${sha256Hex("b")}\n`);
    expect(computePackageDigest([{ path: "a.md", sha256: sha256Hex("a") }])).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
