import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  BaseChannel,
  readContractDir,
  writeContractFiles,
  type ChannelFiles,
} from "./condition.js";

// Condition "files": agents coordinate through an ordinary shared
// directory — the baseline every other condition is compared against.

export class FilesChannel extends BaseChannel {
  readonly kind = "files" as const;
  private readonly sharedDir: string;

  constructor(runDir: string) {
    super();
    this.sharedDir = path.join(runDir, "shared");
  }

  async setup(): Promise<void> {
    await mkdir(this.sharedDir, { recursive: true });
  }

  protected async persist(files: ChannelFiles): Promise<void> {
    // The shared directory is laid out like a workspace root so the
    // contract area lands under shared/contract/.
    await writeContractFiles(this.sharedDir, files);
  }

  protected async refresh(): Promise<ChannelFiles> {
    return readContractDir(this.sharedDir);
  }
}
