import type {
  ModelReport,
  RuntimeDef,
  SessionRequest,
  SessionResult,
} from "../types.js";
import { StubAdapter } from "./stub.js";
import { CodexAdapter } from "./codex.js";
import { ApiSessionAdapter } from "./api-session.js";

export interface RuntimeAdapter {
  readonly kind: string;
  describe(): ModelReport;
  runSession(req: SessionRequest): Promise<SessionResult>;
}

/** Thrown when an adapter cannot run in this environment at all. */
export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterUnavailableError";
  }
}

export function createAdapter(runtime: RuntimeDef): RuntimeAdapter {
  switch (runtime.adapter) {
    case "stub":
      return new StubAdapter(runtime);
    case "codex":
      return new CodexAdapter(runtime);
    case "api-session":
      return new ApiSessionAdapter(runtime);
    default:
      throw new AdapterUnavailableError(
        `Unknown adapter "${String(runtime.adapter)}" for runtime "${runtime.id}".`,
      );
  }
}
