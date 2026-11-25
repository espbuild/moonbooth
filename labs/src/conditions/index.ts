import type { ConditionKind, ScenarioConfig } from "../types.js";
import type { CoordinationChannel } from "./condition.js";
import { FilesChannel } from "./files.js";
import { GitChannel } from "./git.js";
import { MoonboothChannel } from "./moonbooth.js";

export function createChannel(
  kind: ConditionKind,
  runDir: string,
  scenario: ScenarioConfig,
  moonboothApiBaseUrlOverride?: string,
): CoordinationChannel {
  switch (kind) {
    case "files":
      return new FilesChannel(runDir);
    case "git":
      return new GitChannel(runDir);
    case "moonbooth":
      return new MoonboothChannel(
        moonboothApiBaseUrlOverride ??
          scenario.moonbooth?.apiBaseUrl ??
          "https://www.moonbooth.ai",
      );
    default:
      throw new Error(`Unknown condition "${String(kind)}".`);
  }
}
