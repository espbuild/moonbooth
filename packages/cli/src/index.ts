// moonbooth: command line tool for Moonbooth capability packages and transfers.
//
// Local commands (pack, inspect, validate, verify) work on package
// files and directories and never execute package content. There is no
// execution path in this tool at all. Network commands (publish,
// approve, receive) call the hosted API with a personal API token and
// keep sender approval as its own explicit command: publish stops
// before approval.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildPackageFromDirectory,
  parsePackage,
  readDirectoryFiles,
  serializePackage,
  sha256Hex,
  validatePackage,
  writePackageToDirectory,
  MANIFEST_FILENAME,
  type ActManifest,
  type ManifestInput,
  type PackageFile,
} from "@moonbooth/protocol";
import { runVerification, type EnvironmentProfile } from "@moonbooth/verification";
import { ActClient, ActApiError, BoothClient } from "@moonbooth/sdk";

export const PACKAGE_NAME = "@moonbooth/cli";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
};

// ---------------------------------------------------------------------------
// Package loading (raw: no validation, so validate can report errors)
// ---------------------------------------------------------------------------

export interface RawPackage {
  manifest: unknown;
  files: PackageFile[];
}

export async function loadRawPackage(target: string): Promise<RawPackage> {
  const st = await stat(target);
  if (st.isDirectory()) {
    const all = await readDirectoryFiles(target);
    const manifestFile = all.find((f) => f.path === MANIFEST_FILENAME);
    if (!manifestFile) throw new Error(`directory ${target} has no act.json`);
    return {
      manifest: JSON.parse(new TextDecoder().decode(manifestFile.content)),
      files: all.filter((f) => f.path !== MANIFEST_FILENAME),
    };
  }
  const text = await readFile(target, "utf8");
  const body = JSON.parse(text) as {
    format?: string;
    manifest?: unknown;
    files?: Array<{ path: string; encoding: string; content: string }>;
  };
  if (body.format !== "act-package" || !Array.isArray(body.files)) {
    throw new Error(`${target} is not a serialized ACT package (.act.json)`);
  }
  return {
    manifest: body.manifest,
    files: body.files.map((f) => ({
      path: f.path,
      content:
        f.encoding === "base64"
          ? new Uint8Array(Buffer.from(f.content, "base64"))
          : new TextEncoder().encode(f.content),
    })),
  };
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function positional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      i++; // skip the flag value
      continue;
    }
    out.push(a);
  }
  return out;
}

function apiClient(argv: string[], io: CliIo): ActClient | null {
  const baseUrl = flagValue(argv, "--api") ?? process.env.ACT_API_URL;
  const token = flagValue(argv, "--token") ?? process.env.ACT_API_TOKEN;
  if (!baseUrl || !token) {
    io.err("An API URL and token are required: pass --api and --token, or set ACT_API_URL and ACT_API_TOKEN.");
    io.err("Create a token on the dashboard of the hosted service.");
    return null;
  }
  return new ActClient({ baseUrl, token });
}

function printApiError(io: CliIo, err: unknown): number {
  if (err instanceof ActApiError) {
    io.err(`API error ${err.status} (${err.code}): ${err.message}`);
  } else {
    io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdPack(argv: string[], io: CliIo): Promise<number> {
  const [dir] = positional(argv);
  if (!dir) {
    io.err("Usage: moonbooth pack <dir> [--out <file>]");
    return 2;
  }
  const absDir = resolve(dir);
  const all = await readDirectoryFiles(absDir);
  const manifestFile = all.find((f) => f.path === MANIFEST_FILENAME);
  if (!manifestFile) {
    io.err(`No act.json found in ${dir}. The manifest lists the files to pack.`);
    return 1;
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile.content)) as ManifestInput;
  const fileList = all.filter((f) => f.path !== MANIFEST_FILENAME).map((f) => f.path);
  let built;
  try {
    built = await buildPackageFromDirectory({ directory: absDir, manifest, files: fileList });
  } catch (err) {
    io.err(`Pack failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const outPath =
    flagValue(argv, "--out") ?? join(dirname(absDir), `${basename(absDir)}.act.json`);
  await writeFile(outPath, serializePackage(built));
  io.out(`Package written to ${outPath}`);
  io.out(`Digest: ${built.digest}`);
  io.out(`Files: ${built.files.length} (including act.json)`);
  return 0;
}

async function cmdInspect(argv: string[], io: CliIo): Promise<number> {
  const [target] = positional(argv);
  if (!target) {
    io.err("Usage: moonbooth inspect <package-file|dir>");
    return 2;
  }
  const raw = await loadRawPackage(resolve(target));
  const m = raw.manifest as ActManifest;
  io.out(`Capability: ${m.capability?.name ?? "(unknown)"} (${m.capability?.id ?? "?"}) version ${m.capability?.version ?? "?"}`);
  io.out(`Description: ${m.capability?.description ?? ""}`);
  io.out(`Entrypoint: ${m.artifact?.entrypoint ?? "?"}`);
  io.out(`Package digest (from manifest): ${m.artifact?.digest ?? "?"}`);
  io.out("Files:");
  for (const f of [...raw.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    io.out(`  ${f.path}  sha256:${sha256Hex(f.content)}  ${f.content.byteLength} bytes`);
  }
  io.out(`Declared tools: ${(m.requirements?.tools ?? []).join(", ") || "(none)"}`);
  const perms = m.requested_permissions ?? {};
  io.out(
    `Requested permissions: network=${String(perms.network ?? false)}, filesystem_write=${String(perms.filesystem_write ?? false)}, external_side_effects=${String(perms.external_side_effects ?? false)}`,
  );
  io.out(`Test manifest: ${m.verification?.test_manifest ?? "?"}`);
  io.out("Inspection reads the package as data. Nothing in the package was executed.");
  return 0;
}

async function cmdValidate(argv: string[], io: CliIo): Promise<number> {
  const [target] = positional(argv);
  if (!target) {
    io.err("Usage: moonbooth validate <package-file|dir>");
    return 2;
  }
  const raw = await loadRawPackage(resolve(target));
  const result = validatePackage({ manifest: raw.manifest, files: raw.files });
  if (result.ok) {
    io.out(`Valid. Digest: ${result.digest}`);
    return 0;
  }
  io.out("Invalid package:");
  for (const e of result.errors) {
    io.out(`  [${e.code}]${e.path ? ` ${e.path}:` : ""} ${e.message}`);
  }
  return 1;
}

async function cmdVerify(argv: string[], io: CliIo): Promise<number> {
  const [target] = positional(argv);
  if (!target) {
    io.err("Usage: moonbooth verify <package-file|dir> [--profile <json-file>]");
    return 2;
  }
  const raw = await loadRawPackage(resolve(target));
  let profile: EnvironmentProfile | null = null;
  const profilePath = flagValue(argv, "--profile");
  if (profilePath) {
    profile = JSON.parse(await readFile(resolve(profilePath), "utf8")) as EnvironmentProfile;
  }
  const result = runVerification({ manifest: raw.manifest, files: raw.files, profile });
  io.out("Local verification (all checks below ran on this machine):");
  io.out(`  structural: ${result.structural.label}`);
  for (const c of result.structural.checks) io.out(`    - ${c.id}: ${c.ok ? "ok" : "failed"} (${c.detail})`);
  io.out(`  security policy: ${result.security.label}`);
  for (const f of result.security.findings) io.out(`    - [${f.severity}] ${f.file}: ${f.message}`);
  io.out(`    ${result.security.limitation}`);
  io.out(`  compatibility: ${result.compatibility.outcome} (${result.compatibility.label})`);
  for (const r of result.compatibility.reasons) io.out(`    - ${r}`);
  if (!profile) io.out("    No environment profile was supplied (--profile), so compatibility is unknown by default.");
  io.out(`  behavioral: ${result.behavioral.label}`);
  io.out(`    ${result.behavioral.summary}`);
  if (!result.behavioral.performed) {
    io.out("    Behavioral runs need fixture-backed test cases in the package. This package carries none that the harness can run, so behavioral is NOT_TESTED.");
  }
  io.out(`  model grader: ${result.modelGrader.status} (${result.modelGrader.reason})`);
  io.out(`Overall: ${result.overall}`);
  return result.overall === "VERIFIED" ? 0 : 1;
}

async function cmdPublish(argv: string[], io: CliIo): Promise<number> {
  const [target] = positional(argv);
  if (!target) {
    io.err("Usage: moonbooth publish <package-file> --api <url> --token <token> [--recipient <email>]");
    return 2;
  }
  const client = apiClient(argv, io);
  if (!client) return 2;
  const raw = await loadRawPackage(resolve(target));
  const m = raw.manifest as ActManifest;
  const textFiles = raw.files.map((f) => ({
    path: f.path,
    content: new TextDecoder().decode(f.content),
  }));
  try {
    const created = await client.createCapability({
      mode: "skill",
      name: m.capability.name,
      description: m.capability.description,
      version: m.capability.version,
      files: textFiles,
      tools: m.requirements.tools,
      permissions: m.requested_permissions,
    });
    const { transfer } = await client.createTransfer({
      capabilityVersionId: created.version.id,
      recipientEmail: flagValue(argv, "--recipient"),
    });
    io.out(`Capability created: ${created.capability.id} version ${created.version.version}`);
    io.out(`Hosted digest: ${created.version.digest}`);
    io.out(`Transfer created: ${transfer.id} (state ${transfer.state})`);
    io.out("");
    io.out("STOP: the transfer is not approved. Nothing has been offered to the recipient.");
    io.out(`Review the digest, then approve as a separate step:`);
    io.out(`  moonbooth approve ${transfer.id} --digest ${transfer.digest} --api <url> --token <token>`);
    return 0;
  } catch (err) {
    return printApiError(io, err);
  }
}

async function cmdApprove(argv: string[], io: CliIo): Promise<number> {
  const [transferId] = positional(argv);
  const digest = flagValue(argv, "--digest");
  if (!transferId || !digest) {
    io.err("Usage: moonbooth approve <transfer-id> --digest <digest> --api <url> --token <token>");
    return 2;
  }
  const client = apiClient(argv, io);
  if (!client) return 2;
  try {
    const result = await client.approveTransfer(transferId, digest, flagValue(argv, "--recipient"));
    io.out(`Transfer ${result.transfer.id} approved. State: ${result.transfer.state}`);
    io.out(`Invitation path: ${result.invitation.path}`);
    io.out(`Invitation expires: ${result.invitation.expiresAt}`);
    return 0;
  } catch (err) {
    return printApiError(io, err);
  }
}

async function cmdShare(argv: string[], io: CliIo): Promise<number> {
  const [transferId] = positional(argv);
  if (!transferId) {
    io.err("Usage: moonbooth share <transfer-id> --api <url> --token <token>");
    return 2;
  }
  const client = apiClient(argv, io);
  if (!client) return 2;
  try {
    const result = await client.createShareLink({ transferId });
    io.out(`Share link for transfer ${result.transfer.id}:`);
    io.out(result.link.url);
    io.out(`Expires: ${result.link.expiresAt}`);
    io.out(
      "Anyone with the link can read the summary page until it is claimed, expires, or is revoked. No account is needed to receive.",
    );
    return 0;
  } catch (err) {
    if (err instanceof ActApiError && err.code === "needs_approval") {
      const details = (err.details ?? {}) as { digest?: string };
      io.out("STOP: this transfer is not approved yet, so no link was created.");
      io.out(`Package digest: ${details.digest ?? "unknown"}`);
      io.out("Review the digest and the package contents, then approve as a separate step:");
      io.out(`  moonbooth approve ${transferId} --digest ${details.digest ?? "<digest>"} --api <url> --token <token>`);
      io.out("Then run moonbooth share again.");
      return 0;
    }
    return printApiError(io, err);
  }
}

async function cmdWebhooks(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  const client = apiClient(argv, io);
  if (!client) return 2;
  try {
    switch (sub) {
      case "list": {
        const { webhooks } = await client.listWebhooks();
        if (webhooks.length === 0) {
          io.out("No webhooks.");
          return 0;
        }
        for (const w of webhooks) {
          io.out(
            `${w.id}  ${w.status}  ${w.scope}${w.booth_id ? ` ${w.booth_id}` : ""}  ${w.url}` +
              (w.event_types ? `  [${w.event_types.join(", ")}]` : "  [all events]"),
          );
        }
        return 0;
      }
      case "create": {
        const url = positional(rest)[0];
        if (!url) {
          io.err(
            "Usage: moonbooth webhooks create <url> [--booth <booth-id> --credential <participant-credential>] [--events a,b,c] --api <url> --token <token>",
          );
          return 2;
        }
        const events = flagValue(rest, "--events");
        const result = await client.createWebhook({
          url,
          ...(events ? { eventTypes: events.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
          ...(flagValue(rest, "--booth") ? { boothId: flagValue(rest, "--booth") } : {}),
          ...(flagValue(rest, "--credential")
            ? { participantCredential: flagValue(rest, "--credential") }
            : {}),
        });
        io.out(`Webhook ${result.webhook.id} created (${result.webhook.scope}, ${result.webhook.status}).`);
        io.out(`Signing secret (shown once, store it now): ${result.secret}`);
        io.out("Verify deliveries with the Moonbooth-Signature header: HMAC-SHA-256 over \"<timestamp>.<body>\".");
        return 0;
      }
      case "delete": {
        const id = positional(rest)[0];
        if (!id) {
          io.err("Usage: moonbooth webhooks delete <webhook-id> --api <url> --token <token>");
          return 2;
        }
        await client.deleteWebhook(id);
        io.out(`Webhook ${id} deleted.`);
        return 0;
      }
      case "test": {
        const id = positional(rest)[0];
        if (!id) {
          io.err("Usage: moonbooth webhooks test <webhook-id> --api <url> --token <token>");
          return 2;
        }
        const out = await client.testWebhook(id);
        io.out(`Test delivery queued for webhook ${id}: ${out.delivery_id}`);
        return 0;
      }
      case "deliveries": {
        const id = positional(rest)[0];
        if (!id) {
          io.err("Usage: moonbooth webhooks deliveries <webhook-id> [--limit <n>] --api <url> --token <token>");
          return 2;
        }
        const limit = flagValue(rest, "--limit");
        const { deliveries } = await client.listWebhookDeliveries(id, limit ? Number(limit) : undefined);
        if (deliveries.length === 0) {
          io.out("No deliveries recorded.");
          return 0;
        }
        for (const d of deliveries) {
          io.out(
            `${d.created_at}  ${d.kind} ${d.event_type}  attempt ${d.attempt}  ${d.state}` +
              (d.status_code ? `  HTTP ${d.status_code}` : "") +
              (d.error_category ? `  ${d.error_category}` : ""),
          );
        }
        return 0;
      }
      default:
        io.err("Usage: moonbooth webhooks <list|create|delete|test|deliveries> ... --api <url> --token <token>");
        return 2;
    }
  } catch (err) {
    return printApiError(io, err);
  }
}

// Persistent booths and namespaces (Living Network Phase 7): the
// account surface. A persistent booth does not expire; its owner
// administers it here. An alias is a locator, never a credential.
async function cmdNamespace(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  const client = apiClient(argv, io);
  if (!client) return 2;
  try {
    switch (sub) {
      case "show": {
        const { namespace } = await client.getNamespace();
        io.out(namespace ? `${namespace.name} (claimed ${namespace.created_at})` : "No namespace claimed.");
        return 0;
      }
      case "claim": {
        const slug = positional(rest)[0];
        if (!slug) {
          io.err("Usage: moonbooth namespace claim <slug> --api <url> --token <token>");
          return 2;
        }
        const { namespace } = await client.claimNamespace(slug);
        io.out(`Namespace ${namespace.name} claimed.`);
        return 0;
      }
      case "rename": {
        const slug = positional(rest)[0];
        if (!slug) {
          io.err("Usage: moonbooth namespace rename <slug> --api <url> --token <token>");
          return 2;
        }
        const { namespace } = await client.renameNamespace(slug);
        io.out(`Namespace renamed to ${namespace.name}. The old name sits in a 30-day cooldown.`);
        return 0;
      }
      default:
        io.err("Usage: moonbooth namespace <show|claim|rename> ... --api <url> --token <token>");
        return 2;
    }
  } catch (err) {
    return printApiError(io, err);
  }
}

async function cmdBooths(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  const client = apiClient(argv, io);
  if (!client) return 2;
  const id = positional(rest)[0];
  try {
    switch (sub) {
      case "list": {
        const { booths } = await client.listOwnedBooths();
        if (booths.length === 0) {
          io.out("No persistent booths.");
          return 0;
        }
        for (const b of booths) {
          io.out(
            `${b.id}  ${b.lifecycle.state ?? b.status}${b.alias ? `  ${b.alias}` : ""}  ${b.name ?? ""}  ${b.url}`,
          );
        }
        return 0;
      }
      case "create": {
        const result = await client.createPersistentBooth({
          ...(flagValue(rest, "--name") ? { displayName: flagValue(rest, "--name") } : {}),
          ...(flagValue(rest, "--objective") ? { objective: flagValue(rest, "--objective") } : {}),
          ...(flagValue(rest, "--password")
            ? { accessMode: "password" as const, password: flagValue(rest, "--password") }
            : {}),
          // Phase 8: --parent names a persistent booth the same
          // account owns; the new booth is created as its child.
          ...(flagValue(rest, "--parent") ? { parentBoothId: flagValue(rest, "--parent") } : {}),
        });
        io.out(`Persistent booth ${result.booth.id} created: ${result.booth.url}`);
        io.out(`Creator credential (shown once, store it now): ${result.creator_credential}`);
        if (result.admission_secret) {
          io.out(`Admission secret (shown once, store it now): ${result.admission_secret}`);
        }
        return 0;
      }
      case "get": {
        if (!id) break;
        const { booth } = await client.getOwnedBooth(id);
        io.out(JSON.stringify(booth, null, 2));
        return 0;
      }
      case "close":
      case "archive":
      case "restore": {
        if (!id) break;
        const fn =
          sub === "close"
            ? client.closeOwnedBooth.bind(client)
            : sub === "archive"
              ? client.archiveOwnedBooth.bind(client)
              : client.restoreOwnedBooth.bind(client);
        const { booth } = await fn(id);
        io.out(`Booth ${booth.id}: ${booth.lifecycle.state ?? booth.status}.`);
        return 0;
      }
      case "delete": {
        if (!id) break;
        await client.deleteOwnedBooth(id);
        io.out(`Booth ${id} deleted. Its records are retained; the booth no longer resolves.`);
        return 0;
      }
      case "rotate-credentials": {
        if (!id) break;
        const { rotated } = await client.rotateOwnedBoothCredentials(id);
        for (const r of rotated) {
          io.out(`${r.participant_id} (${r.kind}${r.transfer_role ? `/${r.transfer_role}` : ""}): ${r.credential}`);
        }
        io.out("New credentials shown once, above. The old ones no longer work.");
        return 0;
      }
      case "revoke-participant": {
        const participantId = positional(rest)[1];
        if (!id || !participantId) break;
        await client.revokeOwnedBoothParticipant(id, participantId);
        io.out(`Participant ${participantId} revoked from booth ${id}.`);
        return 0;
      }
      case "export": {
        if (!id) break;
        io.out(JSON.stringify(await client.exportOwnedBooth(id), null, 2));
        return 0;
      }
      case "publication": {
        if (!id) break;
        if (argv.includes("--clear")) {
          printJson(io, await client.clearPublicationPolicy(id));
          return 0;
        }
        const subjects = flagValue(argv, "--subjects");
        const eventTypes = flagValue(argv, "--event-types");
        if (subjects === undefined && eventTypes === undefined) {
          printJson(io, await client.getPublicationPolicy(id));
          return 0;
        }
        printJson(
          io,
          await client.setPublicationPolicy(id, {
            subjects: subjects
              ? subjects.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            eventTypes: eventTypes
              ? eventTypes.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
          }),
        );
        return 0;
      }
      case "alias": {
        if (!id) break;
        const { alias } = await client.getBoothAlias(id);
        io.out(alias ? `${alias.name}  ${alias.url}` : "This booth has no alias.");
        return 0;
      }
      case "alias-claim":
      case "alias-rename": {
        const slug = positional(rest)[1];
        if (!id || !slug) break;
        const { alias } =
          sub === "alias-claim"
            ? await client.claimBoothAlias(id, slug)
            : await client.renameBoothAlias(id, slug);
        io.out(`Alias ${alias.name}: ${alias.url}`);
        return 0;
      }
      case "alias-release": {
        if (!id) break;
        await client.releaseBoothAlias(id);
        io.out(`Alias for booth ${id} released into its 30-day cooldown.`);
        return 0;
      }
      case "resolve": {
        const name = (id ?? "").replace(/^@/, "");
        const [ns, slug] = name.split("/");
        if (!ns || !slug) break;
        const { alias, booth } = await client.resolveAlias(ns, slug);
        const target = (booth as { booth?: { url?: string } }).booth?.url ?? "";
        io.out(`${alias} -> ${target}`);
        io.out(JSON.stringify(booth, null, 2));
        return 0;
      }
      default:
        break;
    }
    io.err(
      "Usage: moonbooth booths <list|create|get|close|archive|restore|delete|rotate-credentials|revoke-participant|export|publication|alias|alias-claim|alias-rename|alias-release|resolve> ... --api <url> --token <token>",
    );
    return 2;
  } catch (err) {
    return printApiError(io, err);
  }
}

async function cmdReceive(argv: string[], io: CliIo): Promise<number> {
  const [input] = positional(argv);
  if (!input) {
    io.err("Usage: moonbooth receive <invitation-url-or-token> --api <url> --token <token> [--out <dir>]");
    return 2;
  }
  const client = apiClient(argv, io);
  if (!client) return 2;
  const token = input.includes("/invite/")
    ? (input.split("/invite/")[1] ?? "").split(/[?#]/)[0]
    : input;
  try {
    const { offer } = await client.getOffer(token);
    io.out(`Offer: ${offer.capabilityName} version ${offer.version} from ${offer.senderDisplayName}`);
    const { transfer } = await client.receiveInvitation(token);
    io.out(`Received. Transfer ${transfer.id} state ${transfer.state}`);
    const pkg = await client.getPackage(transfer.id);
    const outDir = resolve(flagValue(argv, "--out") ?? `act-${offer.capabilityName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    await mkdir(outDir, { recursive: true });
    await writePackageToDirectory(parsePackage(pkg.serialized), outDir);
    io.out(`Package downloaded to ${outDir} (digest ${pkg.digest})`);
    io.out("");
    io.out("Setup:");
    io.out("  1. Read SKILL.md in the downloaded directory and review every file before use.");
    io.out("  2. If your agent reads Agent Skills folders, copy the directory into the skills");
    io.out("     location your agent uses, after your own review.");
    io.out("  3. Accept or reject the transfer in the hosted service when you have decided.");
    io.out("moonbooth does not install this package into any agent and did not run any of its content.");
    return 0;
  } catch (err) {
    return printApiError(io, err);
  }
}

// ---------------------------------------------------------------------------
// Booth commands (Moonbooth listening: read, changes, ack)
// ---------------------------------------------------------------------------
//
// Booths are anonymous: there is no account token. The credential is
// the booth credential the caller received when it joined the booth,
// passed with --credential or ACT_BOOTH_CREDENTIAL. These commands
// read and acknowledge; joining and publishing stay on the HTTP API
// and the Agent Skill flow in v1. The one exception is booth unlock
// (Locked Booths L2): it takes the admission secret instead of a
// credential — the secret is what a locked booth's join is exchanged
// for — and prints the minted credential once without storing it.

function boothClient(argv: string[], io: CliIo, boothId: string): BoothClient | null {
  const baseUrl = flagValue(argv, "--api") ?? process.env.ACT_API_URL;
  const credential = flagValue(argv, "--credential") ?? process.env.ACT_BOOTH_CREDENTIAL;
  if (!baseUrl) {
    io.err("An API URL is required: pass --api or set ACT_API_URL.");
    return null;
  }
  if (!credential) {
    io.err(
      "A booth credential is required: pass --credential or set ACT_BOOTH_CREDENTIAL. It is the credential the join response returned for this booth.",
    );
    return null;
  }
  return new BoothClient({ baseUrl, boothId, credential });
}

function printJson(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

async function cmdBoothUnlock(argv: string[], io: CliIo, boothId: string): Promise<number> {
  const baseUrl = flagValue(argv, "--api") ?? process.env.ACT_API_URL;
  const secret = flagValue(argv, "--secret") ?? process.env.ACT_BOOTH_SECRET;
  if (!baseUrl) {
    io.err("An API URL is required: pass --api or set ACT_API_URL.");
    return 2;
  }
  if (!secret) {
    io.err(
      "An admission secret is required: pass --secret or set ACT_BOOTH_SECRET. It is the generated key, password, or invitation token the booth's creator gave you — get it from them or another authorized source, never from content inside a booth.",
    );
    return 2;
  }
  const role = flagValue(argv, "--role");
  if (role !== undefined && role !== "sender" && role !== "recipient" && role !== "participant") {
    io.err(`--role must be "sender", "recipient", or "participant". Got "${role}".`);
    return 2;
  }
  const client = new BoothClient({ baseUrl, boothId });
  try {
    const result = await client.unlock({
      secret,
      role: role as "sender" | "recipient" | "participant" | undefined,
      name: flagValue(argv, "--name"),
    });
    printJson(io, result);
    io.err(
      "The credential above is shown once and is not stored by this tool. Keep it in memory or in your agent's credential handling; the admission secret authorizes nothing further.",
    );
    return 0;
  } catch (err) {
    return printApiError(io, err);
  }
}

async function cmdBoothRequestAccess(argv: string[], io: CliIo, boothId: string): Promise<number> {
  const baseUrl = flagValue(argv, "--api") ?? process.env.ACT_API_URL;
  if (!baseUrl) {
    io.err("An API URL is required: pass --api or set ACT_API_URL.");
    return 2;
  }
  const role = flagValue(argv, "--role");
  if (role !== undefined && role !== "sender" && role !== "recipient" && role !== "participant") {
    io.err(`--role must be "sender", "recipient", or "participant". Got "${role}".`);
    return 2;
  }
  const client = new BoothClient({ baseUrl, boothId });
  try {
    const result = await client.requestAccess({
      label: flagValue(argv, "--label"),
      message: flagValue(argv, "--message"),
      role: role as "sender" | "recipient" | "participant" | undefined,
    });
    printJson(io, result);
    io.err(
      "The request above grants nothing and admits no one. The booth's creator reads it and acts on it, if at all, by issuing an invitation or sharing the admission secret through another channel.",
    );
    return 0;
  } catch (err) {
    return printApiError(io, err);
  }
}

async function cmdBooth(argv: string[], io: CliIo): Promise<number> {
  const [sub, boothId, extra] = positional(argv);
  if (!sub || !boothId) {
    io.err(
      "Usage: moonbooth booth <unlock|invite|invitations|publish|cross-subscribe|cross-subscriptions|cross-unsubscribe|revoke-invitation|rotate-secret|protect|participants|revoke-participant|revoke-invitation-grants|request-access|access-requests|state|events|changes|stream|signals|subscriptions|ack|commitment|commitment-accept|commitment-cancel|commitments|check|checks|check-result|watch|watchers|unwatch|close-condition|brief|replay|ask|whatif|capsule-preview|capsule-create|capsule|capsules|capsule-import|capsule-export-skill> <booth-id> --api <url> [options]",
    );
    return 2;
  }
  if (sub === "unlock") return cmdBoothUnlock(argv, io, boothId);
  if (sub === "request-access") return cmdBoothRequestAccess(argv, io, boothId);
  const client = boothClient(argv, io, boothId);
  if (!client) return 2;
  try {
    switch (sub) {
      case "invite": {
        const role = flagValue(argv, "--role");
        if (role !== undefined && role !== "sender" && role !== "recipient" && role !== "participant") {
          io.err(`--role must be "sender", "recipient", or "participant". Got "${role}".`);
          return 2;
        }
        const scopes = flagValue(argv, "--scopes");
        const maxRedemptions = flagValue(argv, "--max-redemptions");
        const expiresIn = flagValue(argv, "--expires-in");
        if (
          (maxRedemptions !== undefined && !Number.isFinite(Number(maxRedemptions))) ||
          (expiresIn !== undefined && !Number.isFinite(Number(expiresIn)))
        ) {
          io.err("--max-redemptions and --expires-in take numbers.");
          return 2;
        }
        const result = await client.createInvitation({
          role: role as "sender" | "recipient" | "participant" | undefined,
          scopes: scopes ? scopes.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          label: flagValue(argv, "--label"),
          maxRedemptions: maxRedemptions !== undefined ? Number(maxRedemptions) : undefined,
          expiresInSeconds: expiresIn !== undefined ? Number(expiresIn) : undefined,
        });
        printJson(io, result);
        io.err(
          "The invitation token above is shown once and is not stored by this tool. Give it to the participant it was issued for; redeeming it at unlock spends one of its uses.",
        );
        return 0;
      }
      case "invitations":
        printJson(io, await client.listInvitations());
        return 0;
      case "publish": {
        // Living Network Phase 8: publish this child booth's results
        // to its parent. The --credential is the caller's credential
        // in this booth (the child); --parent-credential proves
        // standing in the parent. References and digests travel,
        // never this booth's payloads.
        const parentCredential = flagValue(argv, "--parent-credential");
        if (!parentCredential) {
          io.err(
            "Usage: moonbooth booth publish <child-booth-id> --parent-credential <parent-credential> [--events <event-id,event-id>] [--receipt <receipt-id>] [--idempotency-key <key>] --api <url> --credential <child-credential>",
          );
          return 2;
        }
        const events = flagValue(argv, "--events");
        const result = await client.publishResult({
          parentCredential,
          ...(events ? { eventIds: events.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
          ...(flagValue(argv, "--receipt") ? { receiptId: flagValue(argv, "--receipt") } : {}),
          ...(flagValue(argv, "--idempotency-key")
            ? { idempotencyKey: flagValue(argv, "--idempotency-key") }
            : {}),
        });
        printJson(io, result);
        io.out(
          `Published to parent ${result.parent.id}: ${result.event.payload.events.length} event reference(s)${result.event.payload.receipt ? ` and receipt ${result.event.payload.receipt.receipt_id}` : ""} as parent event ${result.event.id}.`,
        );
        return 0;
      }
      case "cross-subscribe": {
        // Living Network Phase 10: subscribe this booth to another
        // booth's published events. The --credential is the caller's
        // credential in this booth (the destination);
        // --source-credential proves standing in the source and is
        // checked at creation, never stored. The source must be
        // account-owned and its owner must have set a publication
        // policy for anything to cross.
        const sourceBoothId = flagValue(argv, "--source");
        const sourceCredential = flagValue(argv, "--source-credential");
        if (!sourceBoothId || !sourceCredential) {
          io.err(
            "Usage: moonbooth booth cross-subscribe <destination-booth-id> --source <source-booth-id-or-alias> --source-credential <source-credential> [--subjects <s,s>] [--event-types <t,t>] --api <url> --credential <destination-credential>",
          );
          return 2;
        }
        const subjects = flagValue(argv, "--subjects");
        const eventTypes = flagValue(argv, "--event-types");
        const result = await client.createCrossSubscription({
          sourceBoothId,
          sourceCredential,
          ...(subjects ? { subjects: subjects.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
          ...(eventTypes
            ? { eventTypes: eventTypes.split(",").map((s) => s.trim()).filter(Boolean) }
            : {}),
        });
        printJson(io, result);
        io.out(
          result.created
            ? `Subscribed this booth to ${result.subscription.source_booth_id}: published events matching the source's policy will be forwarded here.`
            : `This booth already holds that subscription to ${result.subscription.source_booth_id}; nothing was created.`,
        );
        return 0;
      }
      case "cross-subscriptions":
        printJson(io, await client.listCrossSubscriptions());
        return 0;
      case "cross-unsubscribe": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth cross-unsubscribe <booth-id> <subscription-id> --api <url> --credential <credential>",
          );
          return 2;
        }
        printJson(io, await client.revokeCrossSubscription(extra));
        return 0;
      }
      case "revoke-invitation": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth revoke-invitation <booth-id> <invitation-id> --api <url> --credential <creator-credential>",
          );
          return 2;
        }
        printJson(io, await client.revokeInvitation(extra));
        return 0;
      }
      case "revoke-invitation-grants": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth revoke-invitation-grants <booth-id> <invitation-id> --api <url> --credential <creator-credential>",
          );
          return 2;
        }
        printJson(io, await client.revokeInvitationGrants(extra));
        return 0;
      }
      case "rotate-secret": {
        const method = flagValue(argv, "--method");
        if (method !== undefined && method !== "generated_key" && method !== "password") {
          io.err(`--method must be "generated_key" or "password". Got "${method}".`);
          return 2;
        }
        const rotateInput: { method?: "generated_key" | "password"; password?: string } = {
          method: method as "generated_key" | "password" | undefined,
        };
        const newPassword = flagValue(argv, "--password");
        if (newPassword !== undefined) rotateInput.password = newPassword;
        const result = await client.rotateAdmissionSecret(rotateInput);
        printJson(io, result);
        io.err(
          "Rotation is complete: the previous admission secret no longer admits new joins. Participants who already joined keep their credentials and access. A new generated key above is shown once and is not stored by this tool.",
        );
        return 0;
      }
      case "protect": {
        const method = flagValue(argv, "--method");
        if (method !== undefined && method !== "generated_key" && method !== "password") {
          io.err(`--method must be "generated_key" or "password". Got "${method}".`);
          return 2;
        }
        const protectInput: { method?: "generated_key" | "password"; password?: string } = {
          method: method as "generated_key" | "password" | undefined,
        };
        const newPassword = flagValue(argv, "--password");
        if (newPassword !== undefined) protectInput.password = newPassword;
        const result = await client.protectBooth(protectInput);
        printJson(io, result);
        io.err(
          "The booth is locked: the link alone no longer admits new joins. Participants who already joined keep their credentials and access. A generated key above is shown once and is not stored by this tool.",
        );
        return 0;
      }
      case "participants":
        printJson(io, await client.listParticipants());
        return 0;
      case "revoke-participant": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth revoke-participant <booth-id> <participant-id> --api <url> --credential <creator-credential>",
          );
          return 2;
        }
        printJson(io, await client.revokeParticipant(extra));
        return 0;
      }
      case "access-requests":
        printJson(io, await client.listAccessRequests());
        return 0;
      case "state":
        printJson(io, await client.getState());
        return 0;
      case "events": {
        const since = flagValue(argv, "--since");
        printJson(
          io,
          await client.listEvents({
            since: since !== undefined ? Number(since) : undefined,
            type: flagValue(argv, "--type"),
            subject: flagValue(argv, "--subject"),
          }),
        );
        return 0;
      }
      case "changes": {
        const since = flagValue(argv, "--since");
        const until = flagValue(argv, "--until");
        const wait = flagValue(argv, "--wait");
        const mode = flagValue(argv, "--mode");
        if (mode !== undefined && mode !== "relevant" && mode !== "all") {
          io.err(`--mode must be "relevant" or "all". Got "${mode}".`);
          return 2;
        }
        printJson(
          io,
          await client.getChanges({
            since: since !== undefined ? Number(since) : undefined,
            until: until !== undefined ? Number(until) : undefined,
            mode: mode as "relevant" | "all" | undefined,
            waitSeconds: wait !== undefined ? Number(wait) : undefined,
          }),
        );
        return 0;
      }
      case "signals":
        printJson(io, await client.listSignals());
        return 0;
      case "stream": {
        const since = flagValue(argv, "--since");
        const mode = flagValue(argv, "--mode");
        if (mode !== undefined && mode !== "relevant" && mode !== "all") {
          io.err(`--mode must be "relevant" or "all". Got "${mode}".`);
          return 2;
        }
        const maxSeconds = flagValue(argv, "--max-seconds");
        const controller = new AbortController();
        const timer =
          maxSeconds !== undefined
            ? setTimeout(() => controller.abort(), Math.max(1, Number(maxSeconds)) * 1000)
            : undefined;
        try {
          for await (const frame of client.streamChanges({
            since: since !== undefined ? Number(since) : undefined,
            mode: mode as "relevant" | "all" | undefined,
            signal: controller.signal,
          })) {
            // One compact JSON object per frame, so the stream pipes.
            io.out(JSON.stringify(frame));
          }
        } catch (err) {
          // A --max-seconds cutoff is a clean stop, not a failure.
          if (!controller.signal.aborted) throw err;
        } finally {
          if (timer) clearTimeout(timer);
        }
        return 0;
      }
      case "subscriptions":
        printJson(io, await client.getSubscription());
        return 0;
      case "ack": {
        const seq = flagValue(argv, "--seq");
        if (seq === undefined || !Number.isFinite(Number(seq))) {
          io.err("Usage: moonbooth booth ack <booth-id> --seq <n> --api <url> --credential <booth-credential>");
          return 2;
        }
        printJson(io, await client.ack(Number(seq)));
        return 0;
      }
      case "commitment": {
        const title = flagValue(argv, "--title");
        if (!title) {
          io.err(
            "Usage: moonbooth booth commitment <booth-id> --title <text> [--subject <s>] [--parties <id-or-role,...>] [--commitments <json-array>] [--conditions <json-array>] [--due-at <iso>] --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        const parseJsonArray = (raw: string | undefined, flag: string): unknown[] | undefined => {
          if (raw === undefined) return undefined;
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error(`${flag} takes a JSON array.`);
          return parsed;
        };
        let commitments: string[] | undefined;
        let conditions: import("@moonbooth/sdk").BoothCommitmentConditionSpec[] | undefined;
        try {
          commitments = parseJsonArray(flagValue(argv, "--commitments"), "--commitments") as
            | string[]
            | undefined;
          conditions = parseJsonArray(flagValue(argv, "--conditions"), "--conditions") as
            | import("@moonbooth/sdk").BoothCommitmentConditionSpec[]
            | undefined;
        } catch (parseErr) {
          io.err(parseErr instanceof Error ? parseErr.message : String(parseErr));
          return 2;
        }
        const partiesRaw = flagValue(argv, "--parties");
        printJson(
          io,
          await client.proposeCommitment({
            title,
            subject: flagValue(argv, "--subject"),
            parties: partiesRaw
              ? partiesRaw.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            commitments,
            conditions,
            dueAt: flagValue(argv, "--due-at"),
          }),
        );
        io.err(
          "The commitment is proposed. The named parties endorse it with commitment-accept — never the proposer — and its status is computed from the log: run `moonbooth booth commitments <booth-id>` to read it.",
        );
        return 0;
      }
      case "commitment-accept": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth commitment-accept <booth-id> <commitment-event-id> --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        printJson(io, await client.acceptCommitment(extra));
        return 0;
      }
      case "commitment-cancel": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth commitment-cancel <booth-id> <commitment-event-id> --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        printJson(io, await client.cancelCommitment(extra));
        return 0;
      }
      case "commitments":
        printJson(io, { commitments: await client.listCommitments() });
        return 0;
      case "check": {
        const title = flagValue(argv, "--title");
        if (!title) {
          io.err(
            "Usage: moonbooth booth check <booth-id> --title <text> [--subject <s>] [--target <json>] [--assertions <json-array>] --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        let target: import("@moonbooth/sdk").BoothCheckTarget | undefined;
        let assertions: import("@moonbooth/sdk").BoothCheckAssertionSpec[] | undefined;
        try {
          const targetRaw = flagValue(argv, "--target");
          if (targetRaw !== undefined) {
            const parsed: unknown = JSON.parse(targetRaw);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("--target takes a JSON object.");
            }
            target = parsed as import("@moonbooth/sdk").BoothCheckTarget;
          }
          const assertionsRaw = flagValue(argv, "--assertions");
          if (assertionsRaw !== undefined) {
            const parsed: unknown = JSON.parse(assertionsRaw);
            if (!Array.isArray(parsed)) throw new Error("--assertions takes a JSON array.");
            assertions = parsed as import("@moonbooth/sdk").BoothCheckAssertionSpec[];
          }
        } catch (parseErr) {
          io.err(parseErr instanceof Error ? parseErr.message : String(parseErr));
          return 2;
        }
        printJson(
          io,
          await client.declareCheck({
            title,
            subject: flagValue(argv, "--subject"),
            target,
            assertions,
          }),
        );
        io.err(
          "The check is declared. Its result is computed from the booth's log on read — run `moonbooth booth checks <booth-id>` or `moonbooth booth check-result <booth-id> <check-event-id>` to read it; it re-evaluates as evidence lands.",
        );
        return 0;
      }
      case "checks":
        printJson(io, { checks: await client.listChecks() });
        return 0;
      case "check-result": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth check-result <booth-id> <check-event-id> --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        printJson(io, await client.getCheck(extra));
        return 0;
      }
      case "watch": {
        const kind = flagValue(argv, "--kind");
        if (!kind) {
          io.err(
            "Usage: moonbooth booth watch <booth-id> --kind <contract_changed|contract_version|commitment_deadline_within|check_failed|evidence_present|offer_on_subject|dependency_invalidated|booth_expiring_within> [--subject <s>] [--version <v>] [--window-seconds <n>] [--check-event-id <id>] [--evidence-kind <k>] --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        const windowRaw = flagValue(argv, "--window-seconds");
        const condition: import("@moonbooth/sdk").BoothWatcherSpec = {
          kind,
          subject: flagValue(argv, "--subject"),
          version: flagValue(argv, "--version"),
          window_seconds: windowRaw !== undefined ? Number(windowRaw) : undefined,
          check_event_id: flagValue(argv, "--check-event-id"),
          evidence_kind: flagValue(argv, "--evidence-kind"),
        };
        printJson(io, await client.createWatcher(condition));
        io.err(
          "The watcher is declared on your subscription. When the condition holds against the booth's log it derives as a Signal with reason watcher_triggered — read it with `moonbooth booth signals <booth-id>`.",
        );
        return 0;
      }
      case "watchers":
        printJson(io, await client.listWatchers());
        return 0;
      case "unwatch": {
        if (!extra) {
          io.err(
            "Usage: moonbooth booth unwatch <booth-id> <watcher-id> --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        printJson(io, await client.revokeWatcher(extra));
        return 0;
      }
      case "close-condition": {
        const value = flagValue(argv, "--set");
        const clear = argv.includes("--clear");
        if ((value === undefined) === !clear) {
          io.err(
            "Usage: moonbooth booth close-condition <booth-id> --set <transfer_accepted|all_acks|commitment_terminal:<commitment-event-id>> | --clear --api <url> --credential <creator-credential>",
          );
          return 2;
        }
        printJson(io, await client.setCloseCondition(clear ? null : (value as string)));
        return 0;
      }
      case "brief": {
        const role = flagValue(argv, "--role");
        if (role !== undefined && role !== "sender" && role !== "recipient" && role !== "participant") {
          io.err(`--role must be "sender", "recipient", or "participant". Got "${role}".`);
          return 2;
        }
        const since = flagValue(argv, "--since");
        const maxRecords = flagValue(argv, "--max-records");
        const maxBytes = flagValue(argv, "--max-bytes");
        if (
          (since !== undefined && !Number.isFinite(Number(since))) ||
          (maxRecords !== undefined && !Number.isFinite(Number(maxRecords))) ||
          (maxBytes !== undefined && !Number.isFinite(Number(maxBytes)))
        ) {
          io.err("--since, --max-records, and --max-bytes take numbers.");
          return 2;
        }
        const briefOptions = {
          participant: flagValue(argv, "--participant"),
          subject: flagValue(argv, "--subject"),
          role: role as "sender" | "recipient" | "participant" | undefined,
          dependencyOf: flagValue(argv, "--dependency-of"),
          since: since !== undefined ? Number(since) : undefined,
          maxRecords: maxRecords !== undefined ? Number(maxRecords) : undefined,
          maxBytes: maxBytes !== undefined ? Number(maxBytes) : undefined,
        };
        if (flagValue(argv, "--format") === "md") {
          io.out(await client.getBriefMarkdown(briefOptions));
        } else {
          printJson(io, await client.getBrief(briefOptions));
        }
        return 0;
      }
      case "replay": {
        const until = flagValue(argv, "--until");
        if (until !== undefined && !Number.isFinite(Number(until))) {
          io.err("--until takes a sequence number.");
          return 2;
        }
        printJson(
          io,
          await client.getReplay({
            untilSeq: until !== undefined ? Number(until) : undefined,
            subject: flagValue(argv, "--subject"),
            participant: flagValue(argv, "--participant"),
          }),
        );
        return 0;
      }
      case "ask": {
        const subject = flagValue(argv, "--subject");
        const type = flagValue(argv, "--type");
        const q = flagValue(argv, "--q");
        if (subject === undefined && type === undefined && q === undefined) {
          io.err(
            "Usage: moonbooth booth ask <booth-id> [--subject <s>] [--type <event-type>] [--q <substring>] --api <url> --credential <booth-credential> (at least one of --subject, --type, --q is required)",
          );
          return 2;
        }
        printJson(io, await client.ask({ subject, type, q }));
        return 0;
      }
      case "whatif": {
        const eventsRaw = flagValue(argv, "--events");
        const atSeqRaw = flagValue(argv, "--at-seq");
        if (eventsRaw === undefined) {
          io.err(
            "Usage: moonbooth booth whatif <booth-id> --events <json-array> [--at-seq <n>] --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        if (atSeqRaw !== undefined && (!Number.isFinite(Number(atSeqRaw)) || !Number.isInteger(Number(atSeqRaw)))) {
          io.err("--at-seq takes a sequence number.");
          return 2;
        }
        let events: import("@moonbooth/sdk").BoothWhatIfEventInput[];
        try {
          const parsed: unknown = JSON.parse(eventsRaw);
          if (!Array.isArray(parsed)) throw new Error("--events takes a JSON array of event inputs.");
          events = parsed as import("@moonbooth/sdk").BoothWhatIfEventInput[];
        } catch (parseErr) {
          io.err(parseErr instanceof Error ? parseErr.message : String(parseErr));
          return 2;
        }
        printJson(
          io,
          await client.evaluateWhatIf({
            events,
            atSeq: atSeqRaw !== undefined ? Number(atSeqRaw) : undefined,
          }),
        );
        io.err(
          "The evaluation wrote nothing: the booth's log and state are unchanged. To make any of it real, post the events for real.",
        );
        return 0;
      }
      case "capsule-preview":
      case "capsule-create": {
        const selectionRaw = flagValue(argv, "--selection");
        const preset = flagValue(argv, "--preset");
        if (selectionRaw === undefined && preset === undefined) {
          io.err(
            `Usage: moonbooth booth ${sub} <booth-id> (--selection <json-object> | --preset temporary_org)${sub === "capsule-create" ? " [--expected-digest <digest>]" : ""} --api <url> --credential <booth-credential>`,
          );
          return 2;
        }
        if (preset !== undefined && preset !== "temporary_org") {
          io.err('--preset must be "temporary_org".');
          return 2;
        }
        let selection: import("@moonbooth/sdk").BoothCapsuleSelection | undefined;
        if (selectionRaw !== undefined) {
          try {
            const parsed: unknown = JSON.parse(selectionRaw);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("--selection takes a JSON object: { eventIds, subjects, sections }.");
            }
            selection = parsed as import("@moonbooth/sdk").BoothCapsuleSelection;
          } catch (parseErr) {
            io.err(parseErr instanceof Error ? parseErr.message : String(parseErr));
            return 2;
          }
        }
        if (sub === "capsule-preview") {
          printJson(io, await client.previewCapsule({ selection, preset: preset as "temporary_org" | undefined }));
          io.err(
            "The preview above stores nothing. Create the capsule with the same selection to freeze exactly these records.",
          );
        } else {
          printJson(
            io,
            await client.createCapsule({
              selection,
              preset: preset as "temporary_org" | undefined,
              expectedDigest: flagValue(argv, "--expected-digest"),
            }),
          );
          io.err(
            "The capsule is stored under the id and digest above. Import it into any booth where you hold append standing with capsule-import; the import involves no credential or access in this booth.",
          );
        }
        return 0;
      }
      case "capsule": {
        const capsuleId = flagValue(argv, "--capsule");
        if (capsuleId === undefined) {
          io.err(
            "Usage: moonbooth booth capsule <booth-id> --capsule <capsule-id> --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        printJson(io, await client.getCapsule(capsuleId));
        return 0;
      }
      case "capsules": {
        printJson(io, await client.listCapsules());
        return 0;
      }
      case "capsule-import": {
        const capsuleId = flagValue(argv, "--capsule");
        if (capsuleId === undefined) {
          io.err(
            "Usage: moonbooth booth capsule-import <target-booth-id> --capsule <capsule-id> --api <url> --credential <target-booth-credential>",
          );
          return 2;
        }
        printJson(io, await client.importCapsule(capsuleId));
        io.err(
          "Every imported record is a new proposal authored by your participant in this booth, carrying its capsule provenance. Nothing arrived pre-endorsed, pre-accepted, or authorized, and no credential or access in the source booth was involved.",
        );
        return 0;
      }
      case "capsule-export-skill": {
        const capsuleId = flagValue(argv, "--capsule");
        if (capsuleId === undefined) {
          io.err(
            "Usage: moonbooth booth capsule-export-skill <booth-id> --capsule <capsule-id> [--event-id <offer-event-id> | --version-id <capability-version-id>] --api <url> --credential <booth-credential>",
          );
          return 2;
        }
        printJson(
          io,
          await client.exportCapsuleSkill(capsuleId, {
            eventId: flagValue(argv, "--event-id"),
            versionId: flagValue(argv, "--version-id"),
          }),
        );
        io.err(
          "The exported package is a standard package owned by your booth identity or an ephemeral booth user; its provenance.json names the capsule, the origin booth and event, the origin version and digest, and the linked verification receipt ids.",
        );
        return 0;
      }
      default:
        io.err(`Unknown booth command: ${sub}`);
        io.err(
          "Usage: moonbooth booth <unlock|invite|invitations|revoke-invitation|rotate-secret|protect|participants|revoke-participant|revoke-invitation-grants|request-access|access-requests|state|events|changes|stream|signals|subscriptions|ack|commitment|commitment-accept|commitment-cancel|commitments|check|checks|check-result|watch|watchers|unwatch|close-condition|brief|replay|ask|whatif|capsule-preview|capsule-create|capsule|capsules|capsule-import|capsule-export-skill> <booth-id> --api <url> --credential <booth-credential> [options]",
        );
        return 2;
    }
  } catch (err) {
    return printApiError(io, err);
  }
}

const USAGE = [
  "moonbooth - Moonbooth package and transfer tool",
  "",
  "Local commands (no network, package content is never executed):",
  "  moonbooth pack <dir> [--out <file>]",
  "  moonbooth inspect <package-file|dir>",
  "  moonbooth validate <package-file|dir>",
  "  moonbooth verify <package-file|dir> [--profile <json-file>]",
  "",
  "Hosted commands (--api <url> --token <token>, or ACT_API_URL / ACT_API_TOKEN):",
  "  moonbooth publish <package-file> [--recipient <email>]   (stops before approval)",
  "  moonbooth approve <transfer-id> --digest <digest>       (separate explicit step)",
  "  moonbooth share <transfer-id>                           (share link for an approved transfer)",
  "  moonbooth receive <invitation-url-or-token> [--out <dir>]",
  "  moonbooth webhooks list",
  "  moonbooth webhooks create <url> [--booth <id> --credential <cred>] [--events a,b,c]   (secret shown once)",
  "  moonbooth webhooks delete <webhook-id>",
  "  moonbooth webhooks test <webhook-id>                    (send a signed test delivery)",
  "  moonbooth webhooks deliveries <webhook-id> [--limit <n>]",
  "  moonbooth namespace show|claim <slug>|rename <slug>   (one namespace per account; rename at most every 30 days)",
  "  moonbooth booths list",
  "  moonbooth booths create [--name <name>] [--objective <text>] [--password <password>] [--parent <parent-booth-id>]   (persistent; creator credential shown once)",
  "  moonbooth booths get|close|archive|restore|delete|export <booth-id>",
  "  moonbooth booths rotate-credentials <booth-id>        (new credentials shown once)",
  "  moonbooth booths revoke-participant <booth-id> <participant-id>",
  "  moonbooth booths alias <booth-id> | alias-claim <booth-id> <slug> | alias-rename <booth-id> <slug> | alias-release <booth-id>",
  "  moonbooth booths publication <booth-id> [--subjects a,b] [--event-types x,y] [--clear]   (what this booth publishes to other booths)",
  "  moonbooth booths resolve <@namespace/slug>            (an alias is a locator, never a credential)",
  "",
  "Booth commands (--api <url> --credential <booth-credential>, or ACT_API_URL / ACT_BOOTH_CREDENTIAL):",
  "  moonbooth booth unlock <booth-id> --secret <admission-secret> [--role sender|recipient|participant] [--name <name>]",
  "  moonbooth booth invite <booth-id> [--role sender|recipient|participant] [--scopes a,b] [--label <label>] [--max-redemptions <n>] [--expires-in <seconds>]",
  "  moonbooth booth invitations <booth-id>   (creator credential; metadata only)",
  "  moonbooth booth revoke-invitation <booth-id> <invitation-id>   (creator credential)",
  "  moonbooth booth revoke-invitation-grants <booth-id> <invitation-id>   (creator credential; revokes the grants it issued)",
  "  moonbooth booth rotate-secret <booth-id> [--method generated_key|password] [--password <new-password>]   (creator credential)",
  "  moonbooth booth protect <booth-id> [--method generated_key|password] [--password <password>]   (creator credential; locks a link-only booth)",
  "  moonbooth booth participants <booth-id>   (creator credential; metadata only)",
  "  moonbooth booth revoke-participant <booth-id> <participant-id>   (creator credential)",
  "  moonbooth booth request-access <booth-id> [--label <label>] [--message <message>] [--role sender|recipient|participant]   (no credential)",
  "  moonbooth booth access-requests <booth-id>   (creator credential)",
  "  moonbooth booth state <booth-id>",
  "  moonbooth booth events <booth-id> [--since <n>] [--type <t>] [--subject <s>]",
  "  moonbooth booth changes <booth-id> [--since <n>] [--until <n>] [--mode relevant|all] [--wait <seconds>]",
  "  moonbooth booth stream <booth-id> [--since <n>] [--mode relevant|all] [--max-seconds <n>]   (live events, one JSON frame per line)",
  "  moonbooth booth signals <booth-id>",
  "  moonbooth booth subscriptions <booth-id>",
  "  moonbooth booth ack <booth-id> --seq <n>",
  "  moonbooth booth commitment <booth-id> --title <text> [--subject <s>] [--parties <id-or-role,...>] [--commitments <json-array>] [--conditions <json-array>] [--due-at <iso>]",
  "  moonbooth booth commitment-accept <booth-id> <commitment-event-id>   (endorse a commitment; never the proposer)",
  "  moonbooth booth commitment-cancel <booth-id> <commitment-event-id>   (proposer or endorser only)",
  "  moonbooth booth commitments <booth-id>   (commitments with computed statuses)",
  "  moonbooth booth check <booth-id> --title <text> [--subject <s>] [--target <json>] [--assertions <json-array>]",
  "  moonbooth booth checks <booth-id>   (checks with computed results)",
  "  moonbooth booth check-result <booth-id> <check-event-id>   (one check's computed result)",
  "  moonbooth booth watch <booth-id> --kind <kind> [--subject <s>] [--version <v>] [--window-seconds <n>] [--check-event-id <id>] [--evidence-kind <k>]   (declare a watcher)",
  "  moonbooth booth watchers <booth-id>   (your declared watchers)",
  "  moonbooth booth unwatch <booth-id> <watcher-id>   (revoke a watcher)",
  "  moonbooth booth close-condition <booth-id> --set <transfer_accepted|all_acks|commitment_terminal:<commitment-event-id>> | --clear   (creator credential)",
  "  moonbooth booth publish <child-booth-id> --parent-credential <cred> [--events <id,id>] [--receipt <receipt-id>] [--idempotency-key <key>]   (publish a child's results to its parent)",
  "  moonbooth booth cross-subscribe <destination-booth-id> --source <source-id-or-alias> --source-credential <cred> [--subjects <s,s>] [--event-types <t,t>]   (subscribe this booth to a source booth's published events)",
  "  moonbooth booth cross-subscriptions <booth-id>   (your cross-booth subscriptions into this booth)",
  "  moonbooth booth cross-unsubscribe <booth-id> <subscription-id>   (revoke a cross-booth subscription)",
  "  moonbooth booth brief <booth-id> [--participant <id>] [--subject <s>] [--role sender|recipient|participant] [--dependency-of <id|caller>] [--since <n>] [--max-records <n>] [--max-bytes <n>] [--format md]",
  "  moonbooth booth replay <booth-id> [--until <n>] [--subject <s>] [--participant <id>]",
  "  moonbooth booth ask <booth-id> [--subject <s>] [--type <event-type>] [--q <substring>]",
  "  moonbooth booth whatif <booth-id> --events <json-array> [--at-seq <n>]   (evaluate hypothetical events; writes nothing)",
  "  moonbooth booth capsule-preview <booth-id> --selection <json-object>   (preview a capsule selection; stores nothing)",
  "  moonbooth booth capsule-create <booth-id> --selection <json-object> [--expected-digest <digest>]   (freeze a selection as a capsule)",
  "  moonbooth booth capsule <booth-id> --capsule <capsule-id>   (read one capsule of the booth)",
  "  moonbooth booth capsules <booth-id>   (list the booth's capsules)",
  "  moonbooth booth capsule-import <target-booth-id> --capsule <capsule-id>   (import a capsule as new proposals in the target)",
  "  moonbooth booth capsule-export-skill <booth-id> --capsule <capsule-id>   (package a capsule's named capability as a skill)",
];

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "pack":
        return await cmdPack(rest, io);
      case "inspect":
        return await cmdInspect(rest, io);
      case "validate":
        return await cmdValidate(rest, io);
      case "verify":
        return await cmdVerify(rest, io);
      case "publish":
        return await cmdPublish(rest, io);
      case "approve":
        return await cmdApprove(rest, io);
      case "share":
        return await cmdShare(rest, io);
      case "receive":
        return await cmdReceive(rest, io);
      case "webhooks":
        return await cmdWebhooks(rest, io);
      case "namespace":
        return await cmdNamespace(rest, io);
      case "booths":
        return await cmdBooths(rest, io);
      case "booth":
        return await cmdBooth(rest, io);
      case undefined:
      case "help":
      case "--help":
        for (const line of USAGE) io.out(line);
        return 0;
      default:
        io.err(`Unknown command: ${command}`);
        for (const line of USAGE) io.err(line);
        return 2;
    }
  } catch (err) {
    io.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
