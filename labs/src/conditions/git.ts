import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  BaseChannel,
  readContractDir,
  writeContractFiles,
  type ChannelFiles,
} from "./condition.js";

const exec = promisify(execFile);

// Condition "git": agents coordinate through a shared git repository —
// each role works from its own clone, publishes with commit + push,
// and syncs with fetch + reset to the shared main. This is the
// strongest ordinary baseline in the playbook's condition B.

const GIT_ID = ["-c", "user.name=Moonbooth Labs", "-c", "user.email=labs@moonbooth.local"];

export class GitChannel extends BaseChannel {
  readonly kind = "git" as const;
  private readonly bareDir: string;
  private readonly mirrorDir: string;
  private readonly clonesDir: string;

  constructor(runDir: string) {
    super();
    this.bareDir = path.join(runDir, "channel.git");
    this.mirrorDir = path.join(runDir, "channel-mirror");
    this.clonesDir = path.join(runDir, "clones");
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await exec("git", [...GIT_ID, ...args], { cwd });
    return stdout;
  }

  async setup(): Promise<void> {
    await mkdir(path.dirname(this.bareDir), { recursive: true });
    await exec("git", ["init", "--bare", "-b", "main", this.bareDir]);
    await exec("git", ["clone", "--quiet", this.bareDir, this.mirrorDir]);
    await mkdir(this.clonesDir, { recursive: true });
  }

  private async roleClone(role: string): Promise<string> {
    const dir = path.join(this.clonesDir, role);
    try {
      await this.git(["rev-parse", "--git-dir"], dir);
    } catch {
      await exec("git", ["clone", "--quiet", this.bareDir, dir]);
    }
    return dir;
  }

  private async commitAndPush(workdir: string, message: string): Promise<void> {
    await this.git(["add", "-A"], workdir);
    const status = await this.git(["status", "--porcelain"], workdir);
    if (status.trim().length === 0) return;
    await this.git(["commit", "--quiet", "-m", message], workdir);
    await this.git(["push", "--quiet", "origin", "main"], workdir);
  }

  protected async persist(files: ChannelFiles, publisher: string): Promise<void> {
    const workdir =
      publisher === "fixture" || publisher === "driver"
        ? this.mirrorDir
        : await this.roleClone(publisher);
    if (publisher !== "fixture" && publisher !== "driver") {
      await this.git(["fetch", "--quiet", "origin"], workdir);
      await this.git(["reset", "--quiet", "--hard", "origin/main"], workdir).catch(() => {});
    }
    await writeContractFiles(workdir, files);
    await this.commitAndPush(workdir, `labs: ${publisher} publishes ${Object.keys(files).join(", ")}`);
  }

  protected async refresh(): Promise<ChannelFiles> {
    await this.git(["fetch", "--quiet", "origin"], this.mirrorDir);
    await this.git(["reset", "--quiet", "--hard", "origin/main"], this.mirrorDir).catch(
      () => {},
    );
    return readContractDir(this.mirrorDir);
  }
}
