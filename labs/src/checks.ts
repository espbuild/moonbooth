import { exec } from "node:child_process";
import { access, cp, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CheckDef, CheckResult, RoleDef } from "./types.js";
import { writeContractFiles } from "./conditions/condition.js";

const execAsync = promisify(exec);

/**
 * Assemble the merged evaluation workspace: the fixture as the base,
 * each role's owned area overlaid from its session workspace, and the
 * channel's final contract written over the top. Outcome checks run
 * against this merged tree — the same combined result an integration
 * environment would see.
 */
export async function assembleMergedWorkspace(args: {
  fixtureDir: string;
  roles: RoleDef[];
  workspaces: Map<string, string>;
  channelState: Record<string, string>;
  dest: string;
}): Promise<void> {
  await cp(args.fixtureDir, args.dest, { recursive: true });
  for (const role of args.roles) {
    const ws = args.workspaces.get(role.id);
    if (!ws) continue;
    const src = path.join(ws, role.area);
    const exists = await access(src).then(() => true).catch(() => false);
    if (exists) {
      await cp(src, path.join(args.dest, role.area), { recursive: true, force: true });
    }
  }
  await writeContractFiles(args.dest, args.channelState);
}

function parseTap(output: string): { ok: number; notOk: number } {
  let ok = 0;
  let notOk = 0;
  for (const line of output.split("\n")) {
    if (/^ok\s/.test(line)) ok++;
    else if (/^not ok\s/.test(line)) notOk++;
  }
  return { ok, notOk };
}

export async function runChecks(
  checks: CheckDef[],
  mergedDir: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const weight = check.weight ?? 1;
    if (check.kind === "command") {
      let stdout = "";
      let stderr = "";
      let code = 0;
      try {
        const out = await execAsync(check.command!, {
          cwd: mergedDir,
          timeout: 120_000,
          shell: "/bin/sh",
        });
        stdout = out.stdout;
        stderr = out.stderr;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
        code = typeof e.code === "number" ? e.code : 1;
      }
      const passed = code === 0;
      let score = passed ? 1 : 0;
      let detail = `exit ${code}`;
      if (check.partialFromOutput) {
        const { ok, notOk } = parseTap(`${stdout}\n${stderr}`);
        if (ok + notOk > 0) {
          score = ok / (ok + notOk);
          detail += `; assertions ${ok} passed, ${notOk} failed`;
        }
      }
      results.push({
        id: check.id,
        kind: check.kind,
        description: check.description,
        passed,
        score,
        weight,
        detail,
        detectsMissedChange: check.detectsMissedChange,
      });
    } else if (check.kind === "fileExists") {
      const exists = await access(path.join(mergedDir, check.path!))
        .then(() => true)
        .catch(() => false);
      results.push({
        id: check.id,
        kind: check.kind,
        description: check.description,
        passed: exists,
        score: exists ? 1 : 0,
        weight,
        detail: exists ? "present" : `missing: ${check.path}`,
        detectsMissedChange: check.detectsMissedChange,
      });
    } else {
      // fileContains
      let content = "";
      try {
        content = await readFile(path.join(mergedDir, check.path!), "utf8");
      } catch {
        content = "";
      }
      const found = content.includes(check.contains!);
      results.push({
        id: check.id,
        kind: check.kind,
        description: check.description,
        passed: found,
        score: found ? 1 : 0,
        weight,
        detail: found ? "found" : `not found in ${check.path}`,
        detectsMissedChange: check.detectsMissedChange,
      });
    }
  }
  return results;
}
