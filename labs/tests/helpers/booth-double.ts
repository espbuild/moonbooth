import { createServer, type Server } from "node:http";

// A local test double for the Moonbooth booth API, implementing only
// the subset the harness's moonbooth condition uses through
// @moonbooth/sdk: create booth, join participant, append event, list
// events. It exists so the end-to-end dry run can exercise the real
// SDK-over-HTTP code path without a live service or credentials. It
// is a test fixture, not a reference server, and makes no claim about
// the production service's behavior beyond these request/response
// shapes.

interface StoredEvent {
  id: string;
  seq: number;
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  author: unknown;
  in_reply_to: string | null;
  related_ids: string[] | null;
  created_at: string;
}

interface BoothState {
  events: StoredEvent[];
  byIdempotencyKey: Map<string, StoredEvent>;
  participants: number;
}

export interface BoothDouble {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startBoothDouble(): Promise<BoothDouble> {
  const booths = new Map<string, BoothState>();
  let boothCounter = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (chunks.length === 0) return {};
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    };

    void (async () => {
      const boothMatch = url.pathname.match(/^\/api\/v1\/booths(?:\/([^/]+)(\/.*)?)?$/);
      if (!boothMatch) return send(404, { error: { code: "not_found", message: "no route" } });

      if (req.method === "POST" && !boothMatch[1]) {
        const id = `booth-double-${++boothCounter}`;
        booths.set(id, { events: [], byIdempotencyKey: new Map(), participants: 0 });
        return send(201, {
          id,
          url: `http://127.0.0.1/b/${id}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          creator_credential: `creator-credential-${boothCounter}`,
        });
      }

      const booth = booths.get(boothMatch[1]!);
      if (!booth) return send(404, { error: { code: "not_found", message: "no booth" } });
      const suffix = boothMatch[2] ?? "";

      if (req.method === "GET" && suffix === "") {
        return send(200, { id: boothMatch[1], kind: "booth-double" });
      }
      if (req.method === "POST" && suffix === "/join") {
        await readBody();
        booth.participants++;
        return send(200, {
          role: "participant",
          participant_id: `participant-${booth.participants}`,
          credential: `participant-credential-${booth.participants}`,
          credential_note: "test double credential",
          discovery: {},
        });
      }
      if (req.method === "POST" && suffix === "/events") {
        const body = await readBody();
        const key = typeof body.idempotency_key === "string" ? body.idempotency_key : null;
        if (key && booth.byIdempotencyKey.has(key)) {
          return send(200, { event: booth.byIdempotencyKey.get(key), replayed: true });
        }
        const event: StoredEvent = {
          id: `event-${booth.events.length + 1}`,
          seq: booth.events.length + 1,
          type: String(body.type ?? ""),
          subject: String(body.subject ?? ""),
          payload: (body.payload as Record<string, unknown>) ?? {},
          author: null,
          in_reply_to: null,
          related_ids: null,
          created_at: new Date().toISOString(),
        };
        booth.events.push(event);
        if (key) booth.byIdempotencyKey.set(key, event);
        return send(201, { event, replayed: false });
      }
      if (req.method === "GET" && suffix === "/events") {
        const type = url.searchParams.get("type");
        const since = Number(url.searchParams.get("since") ?? "0");
        const events = booth.events.filter(
          (e) => e.seq > since && (type === null || e.type === type),
        );
        return send(200, { events, latest_seq: booth.events.length });
      }
      return send(404, { error: { code: "not_found", message: "no route" } });
    })().catch((err) => {
      send(500, { error: { code: "double_error", message: String(err) } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
