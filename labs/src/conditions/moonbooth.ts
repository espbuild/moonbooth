import { BoothClient, createBooth } from "@moonbooth/sdk";
import { BaseChannel, hashContent, type ChannelFiles } from "./condition.js";

// Condition "moonbooth": agents coordinate through a booth on the
// Moonbooth service, using this repository's own @moonbooth/sdk.
// Each role joins the booth as a named participant; publishing a
// contract file appends a `contract` event carrying the file, and
// syncing folds the booth's contract events back into files.
//
// Credentials (the creator credential from the create, and each
// participant credential from its join) exist only in this process's
// memory. They are never written to a manifest, an export, or a log.

export class MoonboothChannel extends BaseChannel {
  readonly kind = "moonbooth" as const;
  private boothId: string | null = null;
  private creator: BoothClient | null = null;
  private readonly clients = new Map<string, BoothClient>();

  constructor(private readonly apiBaseUrl: string) {
    super();
  }

  async setup(): Promise<void> {
    const result = await createBooth(this.apiBaseUrl, { ttlSeconds: 24 * 3600 });
    this.boothId = result.id;
    this.creator = new BoothClient({
      baseUrl: this.apiBaseUrl,
      boothId: result.id,
      credential: result.creator_credential,
    });
  }

  private async clientFor(publisher: string): Promise<BoothClient> {
    if (publisher === "fixture" || publisher === "driver") {
      if (!this.creator) throw new Error("Moonbooth channel used before setup().");
      return this.creator;
    }
    let client = this.clients.get(publisher);
    if (!client) {
      if (!this.boothId) throw new Error("Moonbooth channel used before setup().");
      client = new BoothClient({ baseUrl: this.apiBaseUrl, boothId: this.boothId });
      await client.joinParticipant({
        name: publisher,
        capabilities: { harness: "moonbooth-labs" },
      });
      this.clients.set(publisher, client);
    }
    return client;
  }

  protected async persist(files: ChannelFiles, publisher: string): Promise<void> {
    const client = await this.clientFor(publisher);
    for (const [rel, content] of Object.entries(files)) {
      await client.appendEvent({
        type: "contract",
        subject: rel,
        payload: { path: rel, content },
        idempotencyKey: hashContent(`${rel}\0${content}`).slice(0, 32),
      });
    }
  }

  protected async refresh(): Promise<ChannelFiles> {
    if (!this.creator) throw new Error("Moonbooth channel used before setup().");
    const { events } = await this.creator.listEvents({ type: "contract" });
    const out: ChannelFiles = {};
    for (const event of events) {
      const payload = event.payload as { path?: unknown; content?: unknown };
      if (typeof payload.path === "string" && typeof payload.content === "string") {
        out[payload.path] = payload.content;
      }
    }
    return out;
  }
}
