import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  ProtocolError,
  buildPackage,
  buildPackageFromDirectory,
  loadPackageFromDirectory,
  parsePackage,
  serializePackage,
  validatePackage,
  writePackageToDirectory,
  type PackageFile,
} from "../src/index.js";
import { goodFiles, manifestInput } from "./helpers.js";

const enc = (s: string) => new TextEncoder().encode(s);
const filesOf = (rec: Record<string, string>): PackageFile[] =>
  Object.entries(rec).map(([path, content]) => ({ path, content: enc(content) }));

function codes(rec: Record<string, string>, manifest?: unknown): string[] {
  const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
  const result = validatePackage({
    manifest: manifest ?? pkg.manifest,
    files: filesOf(rec),
  });
  return result.errors.map((e) => e.code);
}

describe("validatePackage: valid packages", () => {
  it("accepts a built package", () => {
    const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const result = validatePackage({
      manifest: pkg.manifest,
      files: pkg.files.filter((f) => f.path !== "act.json"),
    });
    expect(result.ok).toBe(true);
    expect(result.digest).toBe(pkg.digest);
  });

  it("round-trips through the serialized form with the same digest", () => {
    const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const restored = parsePackage(serializePackage(pkg));
    expect(restored.digest).toBe(pkg.digest);
    expect(restored.manifest).toEqual(pkg.manifest);
  });

  it("round-trips through a directory with the same digest", async () => {
    const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const dir = await mkdtemp(join(tmpdir(), "act-pkg-"));
    await writePackageToDirectory(pkg, dir);
    const loaded = await loadPackageFromDirectory(dir);
    expect(loaded.digest).toBe(pkg.digest);
  });
});

describe("validatePackage: rejection classes", () => {
  it("rejects a missing manifest", () => {
    const result = validatePackage({ manifest: undefined, files: filesOf(goodFiles) });
    expect(result.errors.map((e) => e.code)).toContain("MANIFEST_MISSING");
  });

  it("rejects an invalid manifest", () => {
    expect(codes(goodFiles, { bogus: true })).toContain("MANIFEST_INVALID");
  });

  it("rejects path traversal", () => {
    expect(codes({ ...goodFiles, "../evil.md": "x" })).toContain("PATH_TRAVERSAL");
    expect(codes({ ...goodFiles, "a/../../evil.md": "x" })).toContain("PATH_TRAVERSAL");
  });

  it("rejects absolute and backslash paths", () => {
    expect(codes({ ...goodFiles, "/abs.md": "x" })).toContain("PATH_TRAVERSAL");
    expect(codes({ ...goodFiles, "a\\b.md": "x" })).toContain("PATH_TRAVERSAL");
  });

  it("rejects duplicate paths", () => {
    const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const files = filesOf(goodFiles);
    files.push({ path: "SKILL.md", content: enc("again") });
    const result = validatePackage({ manifest: pkg.manifest, files });
    expect(result.errors.map((e) => e.code)).toContain("DUPLICATE_PATH");
  });

  it("rejects disallowed file types", () => {
    expect(codes({ ...goodFiles, "run.exe": "x" })).toContain("DISALLOWED_FILE_TYPE");
    expect(codes({ ...goodFiles, "run.sh": "echo hi" })).toContain("DISALLOWED_FILE_TYPE");
    expect(codes({ ...goodFiles, noext: "x" })).toContain("DISALLOWED_FILE_TYPE");
  });

  it("rejects a script by shebang even with an allowed extension", () => {
    expect(codes({ ...goodFiles, "notes.md": "#!/bin/sh\necho hi\n" })).toContain(
      "SCRIPT_FILE",
    );
  });

  it("rejects nested archives", () => {
    expect(codes({ ...goodFiles, "bundle.zip": "x" })).toContain("NESTED_ARCHIVE");
    expect(codes({ ...goodFiles, "bundle.tar.gz": "x" })).toContain("NESTED_ARCHIVE");
  });

  it("rejects a file over the size limit", () => {
    const big = "a".repeat(MAX_FILE_BYTES + 1);
    expect(codes({ ...goodFiles, "big.md": big })).toContain("FILE_TOO_LARGE");
  });

  it("rejects a package over the total size limit", () => {
    const chunk = "a".repeat(250 * 1024);
    const rec: Record<string, string> = { ...goodFiles };
    for (let i = 0; i < 5; i++) rec[`chunk-${i}.md`] = chunk;
    expect(codes(rec)).toContain("PACKAGE_TOO_LARGE");
  });

  it("rejects too many files", () => {
    const rec: Record<string, string> = { ...goodFiles };
    for (let i = 0; i < MAX_FILES; i++) rec[`f-${i}.md`] = "x";
    expect(codes(rec)).toContain("TOO_MANY_FILES");
  });

  it("rejects a missing entrypoint", () => {
    const rec = { ...goodFiles };
    delete rec["SKILL.md"];
    expect(codes(rec)).toContain("ENTRYPOINT_MISSING");
  });

  it("rejects a missing test manifest", () => {
    const rec = { ...goodFiles };
    delete rec["tests/manifest.json"];
    expect(codes(rec)).toContain("TEST_MANIFEST_MISSING");
  });

  it("rejects a tampered digest", () => {
    const pkg = buildPackage({ manifest: manifestInput(), files: goodFiles });
    const bad = {
      ...pkg.manifest,
      artifact: { ...pkg.manifest.artifact, digest: "0".repeat(64) },
    };
    expect(codes(goodFiles, bad)).toContain("DIGEST_MISMATCH");
  });
});

describe("buildPackage", () => {
  it("throws a structured error for an invalid package", () => {
    expect(() =>
      buildPackage({
        manifest: manifestInput(),
        files: { ...goodFiles, "evil.sh": "echo hi" },
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects an act.json entry in the file map", () => {
    expect(() =>
      buildPackage({
        manifest: manifestInput(),
        files: { ...goodFiles, "act.json": "{}" },
      }),
    ).toThrow(ProtocolError);
  });
});

describe("directory loading", () => {
  it("rejects symlinks in the explicit file list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "act-symlink-"));
    await writeFile(join(dir, "real.md"), "real\n");
    await symlink(join(dir, "real.md"), join(dir, "link.md"));
    await expect(
      buildPackageFromDirectory({
        directory: dir,
        manifest: manifestInput(),
        files: ["link.md", "SKILL.md", "tests/manifest.json"],
      }),
    ).rejects.toMatchObject({ code: "SYMLINK" });
  });

  it("builds from a directory of listed files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "act-dir-"));
    await writeFile(join(dir, "SKILL.md"), goodFiles["SKILL.md"]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", "manifest.json"), goodFiles["tests/manifest.json"]);
    await writeFile(join(dir, "notes.md"), "notes\n");
    // notes.md is not listed, so it is not part of the package.
    const pkg = await buildPackageFromDirectory({
      directory: dir,
      manifest: manifestInput(),
      files: ["SKILL.md", "tests/manifest.json"],
    });
    expect(pkg.files.map((f) => f.path)).not.toContain("notes.md");
    expect(pkg.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
