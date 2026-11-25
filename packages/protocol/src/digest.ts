import { createHash } from "node:crypto";
import type { ActManifest } from "./manifest.js";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Normalize a package-relative path to its canonical form:
 * POSIX separators, no leading "./", no trailing slash.
 * Validation of dangerous paths (.., absolute) lives in package.ts;
 * this function only normalizes spelling.
 */
export function normalizePackagePath(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Recursively sort object keys so JSON output is byte-stable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical bytes of act.json for digest purposes: the manifest parsed
 * as JSON, artifact.digest replaced with the empty string, keys sorted
 * at every level, serialized with two-space indent and one trailing
 * newline. Binding every other manifest field into the digest while
 * avoiding a self-reference.
 */
export function canonicalManifestBytes(manifest: ActManifest): Uint8Array {
  const zeroed: ActManifest = {
    ...manifest,
    artifact: { ...manifest.artifact, digest: "" },
  };
  const text = JSON.stringify(sortKeys(zeroed), null, 2) + "\n";
  return new TextEncoder().encode(text);
}

export interface DigestEntry {
  path: string;
  sha256: string;
}

/**
 * The canonical digest input: one line per file, "path sha256\n",
 * paths in ascending code-unit order, UTF-8 encoded.
 */
export function canonicalDigestInput(entries: DigestEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return sorted.map((e) => `${e.path} ${e.sha256}\n`).join("");
}

/** Package digest: SHA-256 of the canonical digest input, lowercase hex. */
export function computePackageDigest(entries: DigestEntry[]): string {
  return sha256Hex(new TextEncoder().encode(canonicalDigestInput(entries)));
}
