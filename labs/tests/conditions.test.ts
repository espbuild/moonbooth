import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FilesChannel } from "../src/conditions/files.js";

const V1 = { "contract/api.json": '{"version": 1}\n' };

async function workspaceWith(contract: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "labs-ws-"));
  await mkdir(path.join(dir, "contract"), { recursive: true });
  await writeFile(path.join(dir, "contract", "api.json"), contract, "utf8");
  return dir;
}

describe("files channel publish semantics", () => {
  it("a stale workspace publishes nothing it did not change", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "labs-run-"));
    const channel = new FilesChannel(runDir);
    await channel.setup();
    await channel.seed(V1);
    channel.noteWorkspaceSeeded("frontend", V1);

    // Driver injects v2 while the frontend never syncs.
    await channel.applyInjection({
      id: "inj",
      beforeStepIndex: 0,
      description: "v2",
      files: [{ path: "contract/api.json", content: '{"version": 2}\n' }],
    });

    const staleWs = await workspaceWith('{"version": 1}\n');
    const out = await channel.syncOut("frontend", staleWs);
    expect(out.published).toEqual([]);
    expect(out.rework).toEqual([]);
    // The channel still holds v2: the stale copy did not clobber it.
    const freshWs = await workspaceWith('{"version": 1}\n');
    const into = await channel.syncIn("backend", freshWs);
    expect(into.changed).toEqual(["contract/api.json"]);
    expect(
      await readFile(path.join(freshWs, "contract", "api.json"), "utf8"),
    ).toBe('{"version": 2}\n');
  });

  it("overwriting another role's unseen change counts as rework", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "labs-run-"));
    const channel = new FilesChannel(runDir);
    await channel.setup();
    await channel.seed(V1);
    channel.noteWorkspaceSeeded("backend", V1);
    channel.noteWorkspaceSeeded("frontend", V1);

    // Backend changes the contract and publishes.
    const backendWs = await workspaceWith('{"version": 2, "by": "backend"}\n');
    const first = await channel.syncOut("backend", backendWs);
    expect(first.published).toEqual(["contract/api.json"]);
    expect(first.rework).toEqual([]);

    // Frontend, never having synced, overwrites the same file based on
    // its stale v1 view: backend's change is clobbered -> rework.
    const frontendWs = await workspaceWith('{"version": 2, "by": "frontend"}\n');
    const second = await channel.syncOut("frontend", frontendWs);
    expect(second.published).toEqual(["contract/api.json"]);
    expect(second.rework).toEqual(["contract/api.json"]);

    // A role that syncs first and then edits is a normal sequential
    // edit, not rework.
    const qaWs = await workspaceWith('{"version": 1}\n');
    await channel.syncIn("qa", qaWs);
    await writeFile(
      path.join(qaWs, "contract", "api.json"),
      '{"version": 3, "by": "qa"}\n',
      "utf8",
    );
    const third = await channel.syncOut("qa", qaWs);
    expect(third.published).toEqual(["contract/api.json"]);
    expect(third.rework).toEqual([]);
  });
});
