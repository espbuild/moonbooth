import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalManifestBytes,
  computePackageDigest,
  loadPackageFromDirectory,
  manifestSchema,
  receiptSchema,
  sha256Hex,
  transitionLifecycle,
  transitionVerification,
  validateManifest,
  validatePackage,
  type ActManifest,
  type DigestEntry,
  type PackageFile,
  type TransferState,
} from "../src/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface FixtureFile {
  path: string;
  content?: string;
  contentRepeat?: { char: string; count: number };
}

interface FixtureCase {
  id: string;
  kind: "manifest" | "package" | "transition";
  digest_mode?: "compute" | "fixed";
  input: {
    manifest?: Record<string, unknown>;
    files?: FixtureFile[];
    dimension?: "lifecycle" | "verification";
    initial?: string;
    steps?: string[];
  };
  expected: { ok: boolean; code?: string; final?: string };
}

const index = JSON.parse(
  await readFile(join(repoRoot, "spec", "conformance", "index.json"), "utf8"),
) as { version: string; cases: FixtureCase[] };

function expandFiles(files: FixtureFile[]): PackageFile[] {
  return files.map((f) => ({
    path: f.path,
    content: new TextEncoder().encode(
      f.contentRepeat
        ? f.contentRepeat.char.repeat(f.contentRepeat.count)
        : (f.content ?? ""),
    ),
  }));
}

/** Compute the correct digest for a fixture package, whatever its
 * other defects, so the expected error is the one under test. */
function fixtureDigest(manifest: ActManifest, files: PackageFile[]): string {
  const entries: DigestEntry[] = files.map((f) => ({
    path: f.path,
    sha256: sha256Hex(f.content),
  }));
  entries.push({
    path: "act.json",
    sha256: sha256Hex(canonicalManifestBytes(manifest)),
  });
  return computePackageDigest(entries);
}

describe("conformance fixtures (spec/conformance/index.json)", () => {
  it("index covers every case class the spec requires", () => {
    const ids = index.cases.map((c) => c.id);
    for (const required of [
      "valid-manifest",
      "manifest-unknown-field",
      "manifest-missing-required-field",
      "manifest-bad-semver",
      "manifest-unsupported-act-version",
      "package-tampered-digest",
      "package-script-file",
      "package-path-traversal",
      "package-over-size-limit",
      "valid-transition-sequence",
      "illegal-transition",
    ]) {
      expect(ids).toContain(required);
    }
  });

  for (const fixture of index.cases) {
    it(fixture.id, () => {
      if (fixture.kind === "manifest") {
        const result = validateManifest(fixture.input.manifest);
        expect(result.ok).toBe(fixture.expected.ok);
        if (!result.ok && fixture.expected.code) {
          expect(result.errors.map((e) => e.code)).toContain(fixture.expected.code);
        }
        return;
      }
      if (fixture.kind === "package") {
        const manifest = JSON.parse(
          JSON.stringify(fixture.input.manifest),
        ) as ActManifest;
        const files = expandFiles(fixture.input.files ?? []);
        if (fixture.digest_mode === "compute") {
          manifest.artifact.digest = fixtureDigest(manifest, files);
        }
        const result = validatePackage({ manifest, files });
        expect(result.ok).toBe(fixture.expected.ok);
        if (fixture.expected.code) {
          expect(result.errors.map((e) => e.code)).toContain(fixture.expected.code);
        }
        return;
      }
      // transition
      let state: TransferState =
        fixture.input.dimension === "lifecycle"
          ? {
              lifecycle: fixture.input.initial as TransferState["lifecycle"],
              verification: "NOT_STARTED",
            }
          : {
              lifecycle: "RECEIVED",
              verification: fixture.input.initial as TransferState["verification"],
            };
      let failure: string | undefined;
      for (const step of fixture.input.steps ?? []) {
        const result =
          fixture.input.dimension === "lifecycle"
            ? transitionLifecycle(state, step as TransferState["lifecycle"])
            : transitionVerification(state, step as TransferState["verification"]);
        if (!result.ok) {
          failure = result.errors[0].code;
          break;
        }
        state = result.value;
      }
      expect(failure === undefined).toBe(fixture.expected.ok);
      if (fixture.expected.code) expect(failure).toBe(fixture.expected.code);
      if (fixture.expected.final) {
        const actual =
          fixture.input.dimension === "lifecycle"
            ? state.lifecycle
            : state.verification;
        expect(actual).toBe(fixture.expected.final);
      }
    });
  }
});

describe("published schemas and example", () => {
  it("spec/schemas JSON files match the canonical schema objects", async () => {
    const manifestJson = JSON.parse(
      await readFile(join(repoRoot, "spec", "schemas", "act-manifest.schema.json"), "utf8"),
    );
    const receiptJson = JSON.parse(
      await readFile(join(repoRoot, "spec", "schemas", "act-receipt.schema.json"), "utf8"),
    );
    expect(manifestJson).toEqual(JSON.parse(JSON.stringify(manifestSchema)));
    expect(receiptJson).toEqual(JSON.parse(JSON.stringify(receiptSchema)));
  });

  it("the competitor-research example package validates and its digest matches", async () => {
    const pkg = await loadPackageFromDirectory(
      join(repoRoot, "examples", "competitor-research"),
    );
    expect(pkg.manifest.capability.id).toBe("competitor-research");
    expect(pkg.digest).toBe(pkg.manifest.artifact.digest);
    expect(pkg.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "act.json",
        "SKILL.md",
        "references/example-output.md",
        "tests/manifest.json",
        "tests/public-cases.json",
      ]),
    );
  });
});
