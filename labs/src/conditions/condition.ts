import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConditionKind, InjectionDef } from "../types.js";

// A coordination channel is the medium through which independent
// sessions in a run share state. In this harness the shared artifact
// is the run's contract area (the files under `contract/` in each
// workspace). The three conditions differ only in transport — plain
// shared directory, a shared git repository, or a Moonbooth booth —
// and the harness's diff, publish-history, and rework bookkeeping is
// shared across all three. The harness is the only writer to the
// channel during a run; `refresh()` re-reads the transport so a sync
// genuinely pulls what the transport holds.

export type ChannelFiles = Record<string, string>;

export interface CoordinationChannel {
  readonly kind: ConditionKind;
  setup(): Promise<void>;
  /** Install the fixture's initial contract as the channel state. */
  seed(files: ChannelFiles): Promise<void>;
  /**
   * Record what a role's workspace was seeded with. Publishing is
   * diffed against this baseline: a role publishes only files it
   * actually changed, so a stale workspace can never silently
   * overwrite newer channel state with its seeded copy.
   */
  noteWorkspaceSeeded(role: string, files: ChannelFiles): void;
  /** Pull the channel's current shared files into a role workspace. */
  syncIn(role: string, workspace: string): Promise<{ changed: string[] }>;
  /** Publish a role workspace's shared files to the channel. */
  syncOut(
    role: string,
    workspace: string,
  ): Promise<{ published: string[]; rework: string[] }>;
  /** The driver applies an injected change directly to the channel. */
  applyInjection(injection: InjectionDef): Promise<void>;
  /** Version field of the channel's contract/api.json, when present. */
  currentVersion(): Promise<number | null>;
  teardown(): Promise<void>;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const CONTRACT_DIR = "contract";

export async function readContractDir(workspace: string): Promise<ChannelFiles> {
  const dir = path.join(workspace, CONTRACT_DIR);
  const out: ChannelFiles = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const full = path.join(dir, entry);
    const content = await readFile(full, "utf8").catch(() => null);
    if (content !== null) out[`${CONTRACT_DIR}/${entry}`] = content;
  }
  return out;
}

export async function writeContractFiles(
  workspace: string,
  files: ChannelFiles,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(workspace, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf8");
  }
}

export abstract class BaseChannel implements CoordinationChannel {
  abstract readonly kind: ConditionKind;
  /** Canonical view of what the channel currently holds. */
  protected state = new Map<string, string>();
  /** Last publisher per path, for rework detection. */
  protected publisher = new Map<string, string>();
  /** Per-role baseline: content hashes of what the role's workspace
   * last saw (at seeding or at its last sync in). */
  protected baselines = new Map<string, Map<string, string>>();

  abstract setup(): Promise<void>;
  /** Write files to the transport under the named publisher. */
  protected abstract persist(files: ChannelFiles, publisher: string): Promise<void>;
  /** Read the transport's full current shared state. */
  protected abstract refresh(): Promise<ChannelFiles>;
  async teardown(): Promise<void> {}

  async seed(files: ChannelFiles): Promise<void> {
    await this.persist(files, "fixture");
    this.adopt(files, "fixture");
  }

  noteWorkspaceSeeded(role: string, files: ChannelFiles): void {
    const baseline = new Map<string, string>();
    for (const [rel, content] of Object.entries(files)) {
      baseline.set(rel, hashContent(content));
    }
    this.baselines.set(role, baseline);
  }

  async syncIn(role: string, workspace: string): Promise<{ changed: string[] }> {
    const remote = await this.refresh();
    this.state = new Map(Object.entries(remote));
    const local = await readContractDir(workspace);
    const changedFiles: ChannelFiles = {};
    const changed: string[] = [];
    for (const [rel, content] of Object.entries(remote)) {
      if (local[rel] !== content) {
        changedFiles[rel] = content;
        changed.push(rel);
      }
    }
    await writeContractFiles(workspace, changedFiles);
    this.noteWorkspaceSeeded(role, remote);
    return { changed };
  }

  async syncOut(
    role: string,
    workspace: string,
  ): Promise<{ published: string[]; rework: string[] }> {
    const local = await readContractDir(workspace);
    const baseline = this.baselines.get(role) ?? new Map<string, string>();
    const changed: ChannelFiles = {};
    const rework: string[] = [];
    for (const [rel, content] of Object.entries(local)) {
      // Only files the role changed relative to what it last saw are
      // published. An unchanged-but-stale file stays unpublished.
      if (hashContent(content) === baseline.get(rel)) continue;
      changed[rel] = content;
      const prev = this.publisher.get(rel);
      const channelMovedUnderRole =
        this.state.has(rel) && hashContent(this.state.get(rel)!) !== baseline.get(rel);
      // Rework: the role overwrites a file whose channel content
      // changed under it, by another role, since its last sync — the
      // intervening work must now be redone or reconciled. Changes by
      // the driver (injections) and the fixture seed do not count.
      if (
        channelMovedUnderRole &&
        prev &&
        prev !== role &&
        prev !== "fixture" &&
        prev !== "driver"
      ) {
        rework.push(rel);
      }
    }
    if (Object.keys(changed).length > 0) {
      await this.persist(changed, role);
      this.adopt(changed, role);
      const nextBaseline = new Map(baseline);
      for (const [rel, content] of Object.entries(changed)) {
        nextBaseline.set(rel, hashContent(content));
      }
      this.baselines.set(role, nextBaseline);
    }
    return { published: Object.keys(changed), rework };
  }

  async applyInjection(injection: InjectionDef): Promise<void> {
    const files: ChannelFiles = {};
    for (const f of injection.files) files[f.path] = f.content;
    await this.persist(files, "driver");
    this.adopt(files, "driver");
  }

  async currentVersion(): Promise<number | null> {
    const raw = this.state.get("contract/api.json");
    if (!raw) return null;
    try {
      const doc = JSON.parse(raw) as { version?: unknown };
      return typeof doc.version === "number" ? doc.version : null;
    } catch {
      return null;
    }
  }

  protected adopt(files: ChannelFiles, publisher: string): void {
    for (const [rel, content] of Object.entries(files)) {
      this.state.set(rel, content);
      this.publisher.set(rel, publisher);
    }
  }
}
