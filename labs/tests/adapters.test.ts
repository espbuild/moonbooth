import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdapterUnavailableError, createAdapter } from "../src/adapters/adapter.js";
import type { SessionRequest } from "../src/types.js";

const ROLE = { id: "backend", title: "Backend", area: "src/backend", brief: "Do the task." };

function request(workspace: string): SessionRequest {
  return {
    runId: "test-run",
    role: ROLE,
    stepIndex: 0,
    workspace,
    brief: "Do the task.",
    timeoutSeconds: 30,
    runtime: { id: "t", adapter: "api-session" },
    record: () => {},
  };
}

describe("api-session adapter", () => {
  it("refuses to run when the named environment variable is absent", async () => {
    delete process.env.MOONBOOTH_LABS_API_KEY;
    const adapter = createAdapter({
      id: "api",
      adapter: "api-session",
      options: { apiKeyEnv: "MOONBOOTH_LABS_API_KEY" },
    });
    const ws = await mkdtemp(path.join(os.tmpdir(), "labs-api-"));
    await expect(adapter.runSession(request(ws))).rejects.toBeInstanceOf(
      AdapterUnavailableError,
    );
    await expect(adapter.runSession(request(ws))).rejects.toThrow(
      /MOONBOOTH_LABS_API_KEY is not set/,
    );
  });

  it("runs a single-turn session when a key and a fetch are provided", async () => {
    process.env.MOONBOOTH_LABS_API_KEY = "test-key-not-real";
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "session reply" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
          model: "test-model-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = createAdapter({
      id: "api",
      adapter: "api-session",
      model: "test-model-1",
      options: { apiKeyEnv: "MOONBOOTH_LABS_API_KEY", fetchFn },
    });
    const ws = await mkdtemp(path.join(os.tmpdir(), "labs-api-"));
    const result = await adapter.runSession(request(ws));
    expect(result.status).toBe("completed");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(4);
    // No price table in the harness: cost is never estimated.
    expect(result.usage.costUsd).toBe("not reported");
    expect(await readFile(path.join(ws, "session-output.md"), "utf8")).toBe("session reply");
    delete process.env.MOONBOOTH_LABS_API_KEY;
  });
});

describe("stub adapter", () => {
  it("reports a scripted, deterministic identity", () => {
    const adapter = createAdapter({ id: "stub", adapter: "stub" });
    expect(adapter.describe()).toEqual({
      provider: "labs-stub",
      model: "stub-scripted",
      revision: "deterministic-v1",
    });
  });
});
