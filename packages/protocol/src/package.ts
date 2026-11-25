import { lstat, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { ProtocolError, type StructuredError } from "./errors.js";
import {
  canonicalManifestBytes,
  computePackageDigest,
  normalizePackagePath,
  sha256Hex,
  type DigestEntry,
} from "./digest.js";
import { validateManifest, type ActManifest } from "./manifest.js";

/** Size and count limits. Fixed by spec section 5. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_PACKAGE_BYTES = 1024 * 1024;
export const MAX_FILES = 50;

/** The only file extensions a package may contain. */
export const ALLOWED_EXTENSIONS = [".md", ".txt", ".json", ".yaml", ".yml"] as const;

const ARCHIVE_EXTENSIONS = [
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
];

export const MANIFEST_FILENAME = "act.json";

export interface PackageFile {
  path: string;
  content: Uint8Array;
}

export interface BuiltPackage {
  manifest: ActManifest;
  /** All files including act.json, sorted by path. */
  files: PackageFile[];
  fileDigests: DigestEntry[];
  digest: string;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function hasShebang(content: Uint8Array): boolean {
  return content.length >= 2 && content[0] === 0x23 && content[1] === 0x21; // "#!"
}

/** Check one path spelling. Returns an error or null. */
export function checkPath(path: string): StructuredError | null {
  if (path.length === 0) {
    return { code: "PATH_TRAVERSAL", path, message: "empty file path" };
  }
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\")) {
    return {
      code: "PATH_TRAVERSAL",
      path,
      message: `path "${path}" is absolute or uses non-POSIX separators`,
    };
  }
  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "" || s === ".")) {
    return {
      code: "PATH_TRAVERSAL",
      path,
      message: `path "${path}" contains a traversal or empty segment`,
    };
  }
  return null;
}

/**
 * Validate a package: manifest plus file list (act.json may be passed
 * as a file or omitted; the manifest argument is authoritative).
 * Collects every error it can check rather than stopping at the first.
 */
export function validatePackage(input: {
  manifest: unknown;
  files: PackageFile[];
}): { ok: boolean; errors: StructuredError[]; digest?: string } {
  const errors: StructuredError[] = [];
  const files = input.files.filter(
    (f) => normalizePackagePath(f.path) !== MANIFEST_FILENAME,
  );

  // Manifest presence and shape.
  let manifest: ActManifest | undefined;
  if (input.manifest === undefined || input.manifest === null) {
    errors.push({
      code: "MANIFEST_MISSING",
      path: "/act.json",
      message: "package has no act.json manifest",
    });
  } else {
    const result = validateManifest(input.manifest);
    if (!result.ok) {
      for (const e of result.errors) {
        errors.push({
          ...e,
          code:
            e.code === "UNSUPPORTED_ACT_VERSION"
              ? e.code
              : e.code === "SCHEMA_VALIDATION" || e.code === "UNKNOWN_FIELD" || e.code === "MISSING_FIELD"
                ? "MANIFEST_INVALID"
                : e.code,
          message:
            e.code === "UNSUPPORTED_ACT_VERSION" ? e.message : `manifest: ${e.message}`,
        });
      }
    } else {
      manifest = result.value;
    }
  }

  // File-level checks.
  if (files.length > MAX_FILES) {
    errors.push({
      code: "TOO_MANY_FILES",
      message: `package has ${files.length} files; limit is ${MAX_FILES}`,
    });
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const path = normalizePackagePath(file.path);
    const pathError = checkPath(file.path);
    if (pathError) {
      errors.push(pathError);
      continue;
    }
    if (seen.has(path)) {
      errors.push({
        code: "DUPLICATE_PATH",
        path,
        message: `duplicate file path "${path}"`,
      });
      continue;
    }
    seen.add(path);
    const ext = extensionOf(path);
    if (ARCHIVE_EXTENSIONS.includes(ext) || ARCHIVE_EXTENSIONS.some((a) => path.toLowerCase().endsWith(".tar" + a))) {
      errors.push({
        code: "NESTED_ARCHIVE",
        path,
        message: `nested archive "${path}" is not allowed in a package`,
      });
      continue;
    }
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      errors.push({
        code: "DISALLOWED_FILE_TYPE",
        path,
        message: `file type "${ext || "(none)"}" is not allowed; allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
      });
      continue;
    }
    if (hasShebang(file.content)) {
      errors.push({
        code: "SCRIPT_FILE",
        path,
        message: `file "${path}" starts with a shebang and is treated as a script`,
      });
    }
    if (file.content.byteLength > MAX_FILE_BYTES) {
      errors.push({
        code: "FILE_TOO_LARGE",
        path,
        message: `file "${path}" is ${file.content.byteLength} bytes; limit is ${MAX_FILE_BYTES}`,
      });
    }
    totalBytes += file.content.byteLength;
  }
  if (totalBytes > MAX_PACKAGE_BYTES) {
    errors.push({
      code: "PACKAGE_TOO_LARGE",
      message: `package files total ${totalBytes} bytes; limit is ${MAX_PACKAGE_BYTES}`,
    });
  }

  // Entrypoint and test manifest existence.
  if (manifest) {
    if (!seen.has(normalizePackagePath(manifest.artifact.entrypoint))) {
      errors.push({
        code: "ENTRYPOINT_MISSING",
        path: "/artifact/entrypoint",
        message: `entrypoint "${manifest.artifact.entrypoint}" is not in the package`,
      });
    }
    if (!seen.has(normalizePackagePath(manifest.verification.test_manifest))) {
      errors.push({
        code: "TEST_MANIFEST_MISSING",
        path: "/verification/test_manifest",
        message: `test manifest "${manifest.verification.test_manifest}" is not in the package`,
      });
    }
  }

  // Digest. Computed whenever the manifest parsed, so a tampered
  // package reports DIGEST_MISMATCH alongside any other errors.
  let digest: string | undefined;
  if (manifest) {
    const entries: DigestEntry[] = files.map((f) => ({
      path: normalizePackagePath(f.path),
      sha256: sha256Hex(f.content),
    }));
    entries.push({
      path: MANIFEST_FILENAME,
      sha256: sha256Hex(canonicalManifestBytes(manifest)),
    });
    digest = computePackageDigest(entries);
    if (digest !== manifest.artifact.digest) {
      errors.push({
        code: "DIGEST_MISMATCH",
        path: "/artifact/digest",
        message: `manifest digest ${manifest.artifact.digest} does not match computed digest ${digest}`,
      });
    }
  }

  return { ok: errors.length === 0, errors, digest };
}

export type ManifestInput = Omit<ActManifest, "artifact"> & {
  artifact: Omit<ActManifest["artifact"], "digest"> & { digest?: string };
};

/**
 * Build a package from an in-memory file map (path -> text or bytes).
 * The map must not contain act.json; the builder writes it from the
 * manifest. Returns the package with its computed digest filled in.
 * Throws ProtocolError on any validation failure.
 */
export function buildPackage(input: {
  manifest: ManifestInput;
  files: Map<string, string | Uint8Array> | Record<string, string | Uint8Array>;
}): BuiltPackage {
  const rawEntries: Array<[string, string | Uint8Array]> =
    input.files instanceof Map
      ? [...input.files.entries()]
      : Object.entries(input.files);
  const files: PackageFile[] = rawEntries.map(([path, content]) => ({
    path: normalizePackagePath(path),
    content: toBytes(content),
  }));
  if (files.some((f) => f.path === MANIFEST_FILENAME)) {
    throw new ProtocolError([
      {
        code: "DUPLICATE_PATH",
        path: MANIFEST_FILENAME,
        message: "file map must not contain act.json; it is generated from the manifest",
      },
    ]);
  }

  // First pass with a placeholder digest to surface structural errors.
  const draft: ActManifest = {
    ...input.manifest,
    artifact: { ...input.manifest.artifact, digest: "0".repeat(64) },
  };
  const entries: DigestEntry[] = files.map((f) => ({
    path: f.path,
    sha256: sha256Hex(f.content),
  }));
  entries.push({
    path: MANIFEST_FILENAME,
    sha256: sha256Hex(canonicalManifestBytes(draft)),
  });
  const digest = computePackageDigest(entries);
  const manifest: ActManifest = {
    ...input.manifest,
    artifact: { ...input.manifest.artifact, digest },
  };

  const check = validatePackage({ manifest, files });
  if (!check.ok) throw new ProtocolError(check.errors);

  const manifestFile: PackageFile = {
    path: MANIFEST_FILENAME,
    // The stored act.json uses the same canonical byte form, with the
    // real digest in place of the empty string.
    content: new TextEncoder().encode(
      JSON.stringify(sortKeysForStorage(manifest), null, 2) + "\n",
    ),
  };
  const allFiles = [...files, manifestFile].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const fileDigests = allFiles
    .filter((f) => f.path !== MANIFEST_FILENAME)
    .map((f) => ({ path: f.path, sha256: sha256Hex(f.content) }));
  fileDigests.push({
    path: MANIFEST_FILENAME,
    sha256: sha256Hex(canonicalManifestBytes(manifest)),
  });
  fileDigests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { manifest, files: allFiles, fileDigests, digest };
}

function sortKeysForStorage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysForStorage);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysForStorage((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Build a package from a directory plus an explicit list of relative
 * file paths. Symlinks in the list are rejected. Throws ProtocolError.
 */
export async function buildPackageFromDirectory(input: {
  directory: string;
  manifest: ManifestInput;
  files: string[];
}): Promise<BuiltPackage> {
  const map = new Map<string, Uint8Array>();
  for (const rel of input.files) {
    const pathError = checkPath(rel);
    if (pathError) throw new ProtocolError([pathError]);
    const full = join(input.directory, ...normalizePackagePath(rel).split("/"));
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      throw new ProtocolError([
        { code: "SYMLINK", path: rel, message: `"${rel}" is a symlink; symlinks are not allowed` },
      ]);
    }
    if (!stat.isFile()) {
      throw new ProtocolError([
        { code: "NOT_A_FILE", path: rel, message: `"${rel}" is not a regular file` },
      ]);
    }
    map.set(rel, new Uint8Array(await readFile(full)));
  }
  return buildPackage({ manifest: input.manifest, files: map });
}

/** Read every regular file under a directory (recursive), rejecting symlinks. */
export async function readDirectoryFiles(
  directory: string,
): Promise<PackageFile[]> {
  const out: PackageFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        throw new ProtocolError([
          {
            code: "SYMLINK",
            path: relative(directory, full),
            message: `"${relative(directory, full)}" is a symlink; symlinks are not allowed`,
          },
        ]);
      }
      if (stat.isDirectory()) {
        await walk(full);
      } else if (stat.isFile()) {
        const rel = relative(directory, full).split(sep).join("/");
        out.push({ path: rel, content: new Uint8Array(await readFile(full)) });
      }
    }
  }
  await walk(directory);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Load and validate a package stored as a directory: act.json plus the
 * files it covers. Throws ProtocolError listing every problem found.
 */
export async function loadPackageFromDirectory(
  directory: string,
): Promise<BuiltPackage> {
  const all = await readDirectoryFiles(directory);
  const manifestFile = all.find((f) => f.path === MANIFEST_FILENAME);
  if (!manifestFile) {
    throw new ProtocolError([
      { code: "MANIFEST_MISSING", path: "/act.json", message: "directory has no act.json" },
    ]);
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestFile.content));
  } catch {
    throw new ProtocolError([
      { code: "MANIFEST_INVALID", path: "/act.json", message: "act.json is not valid JSON" },
    ]);
  }
  const files = all.filter((f) => f.path !== MANIFEST_FILENAME);
  const check = validatePackage({ manifest: manifestJson, files });
  if (!check.ok) throw new ProtocolError(check.errors);
  const manifest = manifestJson as ActManifest;
  return {
    manifest,
    files: all,
    fileDigests: files
      .map((f) => ({ path: f.path, sha256: sha256Hex(f.content) }))
      .concat([
        {
          path: MANIFEST_FILENAME,
          sha256: sha256Hex(canonicalManifestBytes(manifest)),
        },
      ])
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    digest: check.digest as string,
  };
}

/** Write a built package to a directory (act.json plus payload files). */
export async function writePackageToDirectory(
  pkg: BuiltPackage,
  directory: string,
): Promise<void> {
  for (const file of pkg.files) {
    const full = join(directory, ...file.path.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.content);
  }
}

/**
 * The portable package form: one JSON document.
 * { format: "act-package", version: "0.1", manifest, files: [...] }
 * Text files are stored as UTF-8 strings; anything else as base64.
 */
export interface SerializedPackage {
  format: "act-package";
  version: "0.1";
  manifest: ActManifest;
  files: Array<{
    path: string;
    encoding: "utf8" | "base64";
    content: string;
  }>;
}

export function serializePackage(pkg: BuiltPackage): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const body: SerializedPackage = {
    format: "act-package",
    version: "0.1",
    manifest: pkg.manifest,
    files: pkg.files
      .filter((f) => f.path !== MANIFEST_FILENAME)
      .map((f) => {
        try {
          return {
            path: f.path,
            encoding: "utf8" as const,
            content: decoder.decode(f.content),
          };
        } catch {
          return {
            path: f.path,
            encoding: "base64" as const,
            content: Buffer.from(f.content).toString("base64"),
          };
        }
      }),
  };
  return JSON.stringify(body, null, 2) + "\n";
}

/** Parse and validate a serialized package. Throws ProtocolError. */
export function parsePackage(serialized: string): BuiltPackage {
  let body: SerializedPackage;
  try {
    body = JSON.parse(serialized) as SerializedPackage;
  } catch {
    throw new ProtocolError([
      { code: "PACKAGE_PARSE", message: "serialized package is not valid JSON" },
    ]);
  }
  if (body.format !== "act-package" || body.version !== "0.1") {
    throw new ProtocolError([
      {
        code: "PACKAGE_PARSE",
        message: `unsupported serialized package form "${String(body.format)}" version "${String(body.version)}"`,
      },
    ]);
  }
  const files: PackageFile[] = body.files.map((f) => ({
    path: f.path,
    content:
      f.encoding === "base64"
        ? new Uint8Array(Buffer.from(f.content, "base64"))
        : new TextEncoder().encode(f.content),
  }));
  const check = validatePackage({ manifest: body.manifest, files });
  if (!check.ok) throw new ProtocolError(check.errors);
  const manifestFile: PackageFile = {
    path: MANIFEST_FILENAME,
    content: new TextEncoder().encode(
      JSON.stringify(sortKeysForStorage(body.manifest), null, 2) + "\n",
    ),
  };
  return {
    manifest: body.manifest,
    files: [...files, manifestFile].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    fileDigests: files
      .map((f) => ({ path: normalizePackagePath(f.path), sha256: sha256Hex(f.content) }))
      .concat([
        {
          path: MANIFEST_FILENAME,
          sha256: sha256Hex(canonicalManifestBytes(body.manifest)),
        },
      ])
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    digest: check.digest as string,
  };
}
