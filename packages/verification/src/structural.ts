import { validatePackage, type PackageFile } from "@moonbooth/protocol";
import type { StructuralCheck, StructuralResult } from "./types.js";

/**
 * Structural verification. Deterministic checks over the package bytes:
 * manifest schema, digest integrity, entrypoint and test manifest
 * presence, and file allowlist compliance. Reuses the protocol
 * validator; this module groups its errors into named checks.
 */

const GROUPS: Array<{ id: string; codes: string[]; okDetail: string }> = [
  {
    id: "manifest_schema",
    codes: ["MANIFEST_MISSING", "MANIFEST_INVALID", "UNSUPPORTED_ACT_VERSION"],
    okDetail: "Manifest parses and matches the ACT 0.1 manifest schema.",
  },
  {
    id: "digest_integrity",
    codes: ["DIGEST_MISMATCH"],
    okDetail: "Recomputed package digest matches the manifest digest.",
  },
  {
    id: "entrypoint_present",
    codes: ["ENTRYPOINT_MISSING"],
    okDetail: "The entrypoint file named in the manifest is in the package.",
  },
  {
    id: "test_manifest_present",
    codes: ["TEST_MANIFEST_MISSING"],
    okDetail: "The test manifest file named in the manifest is in the package.",
  },
  {
    id: "file_allowlist",
    codes: [
      "DISALLOWED_FILE_TYPE",
      "NESTED_ARCHIVE",
      "SCRIPT_FILE",
      "PATH_TRAVERSAL",
      "DUPLICATE_PATH",
      "TOO_MANY_FILES",
      "FILE_TOO_LARGE",
      "PACKAGE_TOO_LARGE",
    ],
    okDetail: "Every file uses an allowed type, a package-relative path, and the size limits.",
  },
];

export function verifyStructural(input: {
  manifest: unknown;
  files: PackageFile[];
  expectedDigest?: string;
}): StructuralResult {
  const check = validatePackage({ manifest: input.manifest, files: input.files });
  const errors = check.errors.map((e) => ({
    code: e.code,
    path: e.path,
    message: e.message,
  }));

  const checks: StructuralCheck[] = GROUPS.map((group) => {
    const groupErrors = errors.filter((e) => group.codes.includes(e.code));
    return {
      id: group.id,
      ok: groupErrors.length === 0,
      detail:
        groupErrors.length === 0
          ? group.okDetail
          : groupErrors.map((e) => e.message).join(" "),
    };
  });

  if (input.expectedDigest) {
    const ok = check.digest !== undefined && check.digest === input.expectedDigest;
    checks.push({
      id: "recorded_digest_matches",
      ok,
      detail: ok
        ? "Recomputed digest matches the digest recorded when the package was stored."
        : `Recomputed digest ${check.digest ?? "(none)"} does not match the recorded digest ${input.expectedDigest}. The stored bytes changed after they were recorded.`,
    });
    if (!ok && !errors.some((e) => e.code === "DIGEST_MISMATCH")) {
      errors.push({
        code: "DIGEST_MISMATCH",
        path: "/artifact/digest",
        message: "Computed digest does not match the recorded artifact digest.",
      });
    }
  }

  const manifestDigest =
    typeof input.manifest === "object" && input.manifest !== null
      ? ((input.manifest as { artifact?: { digest?: unknown } }).artifact?.digest as string) ?? null
      : null;

  const ok = errors.length === 0 && checks.every((c) => c.ok);
  return {
    label: ok ? "VALIDATED" : "FAILED",
    checks,
    errors,
    computedDigest: check.digest ?? null,
    manifestDigest: typeof manifestDigest === "string" ? manifestDigest : null,
  };
}
