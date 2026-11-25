import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ModelReport,
  RuntimeDef,
  SessionRequest,
  SessionResult,
  UsageReport,
} from "../types.js";
import { NOT_REPORTED } from "../types.js";
import { AdapterUnavailableError } from "./adapter.js";

// Codex CLI adapter: runs `codex exec` non-interactively with the
// session workspace as its working root and the workspace-write
// sandbox. Token usage is recorded only when the CLI's JSONL event
// stream reports it; the CLI does not report a dollar cost, so cost
// stays "not reported" — never estimated from token counts.

interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function parseUsage(stdout: string): UsageReport {
  let inputTokens: number | "not reported" = NOT_REPORTED;
  let outputTokens: number | "not reported" = NOT_REPORTED;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as {
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (event.usage) {
        if (typeof event.usage.input_tokens === "number") inputTokens = event.usage.input_tokens;
        if (typeof event.usage.output_tokens === "number") outputTokens = event.usage.output_tokens;
      }
    } catch {
      // Not a JSONL event line; ignore.
    }
  }
  return {
    inputTokens,
    outputTokens,
    costUsd: NOT_REPORTED,
    costMethod: "not reported",
  };
}

export class CodexAdapter {
  readonly kind = "codex";
  private version: string | null = null;

  constructor(private readonly runtime: RuntimeDef) {}

  describe(): ModelReport {
    return {
      provider: "openai-codex-cli",
      model: this.runtime.model ?? NOT_REPORTED,
      revision: this.version ?? NOT_REPORTED,
    };
  }

  async runSession(req: SessionRequest): Promise<SessionResult> {
    if (this.version === null) {
      const v = await runProcess("codex", ["--version"], req.workspace, 15);
      if (v.spawnError) {
        throw new AdapterUnavailableError(
          `codex CLI is not available on PATH (${v.spawnError.message}). Install codex-cli or choose a different adapter.`,
        );
      }
      this.version = v.stdout.trim() || NOT_REPORTED;
    }

    const scratch = await mkdtemp(path.join(os.tmpdir(), "labs-codex-"));
    const lastMessagePath = path.join(scratch, "last-message.txt");
    const args = [
      "exec",
      "-C",
      req.workspace,
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "-o",
      lastMessagePath,
    ];
    if (this.runtime.model) args.push("-m", this.runtime.model);
    args.push(req.brief);

    req.record("codex_exec_started", { model: this.runtime.model ?? "cli-default" });
    const outcome = await runProcess("codex", args, req.workspace, req.timeoutSeconds);
    const usage = parseUsage(outcome.stdout);
    const lastMessage = await readFile(lastMessagePath, "utf8").catch(() => "");
    await rm(scratch, { recursive: true, force: true }).catch(() => {});

    if (outcome.timedOut) {
      return {
        status: "timeout",
        summary: "Codex session exceeded its time budget and was killed.",
        usage,
        model: this.describe(),
        failureCategory: "timeout",
      };
    }
    if (outcome.code !== 0) {
      return {
        status: "failed",
        summary: `Codex exited with code ${outcome.code ?? "unknown"}. ${outcome.stderr.slice(-300)}`,
        usage,
        model: this.describe(),
        failureCategory: "adapter_error",
      };
    }
    return {
      status: "completed",
      summary: lastMessage.trim().slice(0, 500) || "Codex session completed.",
      usage,
      model: this.describe(),
    };
  }
}
