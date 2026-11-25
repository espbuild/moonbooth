import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ModelReport,
  RuntimeDef,
  SessionRequest,
  SessionResult,
} from "../types.js";
import { NOT_REPORTED } from "../types.js";
import { AdapterUnavailableError } from "./adapter.js";

// API-session adapter (skeleton): a single-turn hosted-model session.
// The scenario names the environment variable that holds the API key
// (runtime option `apiKeyEnv`); the adapter refuses to run when that
// variable is absent, so a scenario can never spend money by accident
// or read a key from a config file. When a key is present it sends the
// brief as one chat-completions request (OpenAI-compatible shape) and
// writes the reply to `session-output.md` in the workspace. There is
// deliberately no tool loop yet: multi-step agentic behavior over a
// raw API is future work, and this skeleton exists so scenarios can
// name the adapter and the refusal path is tested.
//
// Cost is "not reported": the harness keeps no price table, and a
// dollar figure derived from one would be an estimate, not a report.

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export class ApiSessionAdapter {
  readonly kind = "api-session";

  constructor(private readonly runtime: RuntimeDef) {}

  private get apiKeyEnv(): string {
    const v = this.runtime.options?.apiKeyEnv;
    return typeof v === "string" && v.length > 0 ? v : "MOONBOOTH_LABS_API_KEY";
  }

  private get endpoint(): string {
    const v = this.runtime.options?.endpoint;
    return typeof v === "string" && v.length > 0
      ? v
      : "https://api.openai.com/v1/chat/completions";
  }

  describe(): ModelReport {
    return {
      provider: "hosted-api",
      model: this.runtime.model ?? NOT_REPORTED,
      revision: NOT_REPORTED,
    };
  }

  async runSession(req: SessionRequest): Promise<SessionResult> {
    const key = process.env[this.apiKeyEnv];
    if (!key) {
      throw new AdapterUnavailableError(
        `api-session adapter refuses to run: environment variable ${this.apiKeyEnv} is not set. ` +
          `Set it to a provider API key, or choose a different adapter. No key is read from config files.`,
      );
    }
    const fetchFn = (this.runtime.options?.fetchFn as FetchFn | undefined) ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutSeconds * 1000);
    let data: ChatResponse;
    try {
      const res = await fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.runtime.model ?? "gpt-4o-mini",
          messages: [{ role: "user", content: req.brief }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          status: "failed",
          summary: `Provider returned HTTP ${res.status}.`,
          usage: { inputTokens: NOT_REPORTED, outputTokens: NOT_REPORTED, costUsd: NOT_REPORTED, costMethod: "not reported" },
          model: this.describe(),
          failureCategory: "adapter_error",
        };
      }
      data = (await res.json()) as ChatResponse;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        status: aborted ? "timeout" : "failed",
        summary: aborted
          ? "API session exceeded its time budget."
          : `API request failed: ${err instanceof Error ? err.message : String(err)}`,
        usage: { inputTokens: NOT_REPORTED, outputTokens: NOT_REPORTED, costUsd: NOT_REPORTED, costMethod: "not reported" },
        model: this.describe(),
        failureCategory: aborted ? "timeout" : "adapter_error",
      };
    } finally {
      clearTimeout(timer);
    }

    const text = data.choices?.[0]?.message?.content ?? "";
    await writeFile(path.join(req.workspace, "session-output.md"), text, "utf8");
    return {
      status: "completed",
      summary: text.slice(0, 500) || "API session completed with an empty reply.",
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? NOT_REPORTED,
        outputTokens: data.usage?.completion_tokens ?? NOT_REPORTED,
        costUsd: NOT_REPORTED,
        costMethod: "not reported",
      },
      model: {
        provider: "hosted-api",
        model: data.model ?? this.runtime.model ?? NOT_REPORTED,
        revision: NOT_REPORTED,
      },
    };
  }
}
