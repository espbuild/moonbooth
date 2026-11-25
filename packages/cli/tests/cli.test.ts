import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli, type CliIo } from "../src/index.js";

const EXAMPLE = resolve(__dirname, "../../../examples/competitor-research");

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: CliIo = { out: (l) => lines.push(l), err: (l) => errors.push(l) };
  return { io, lines, errors, text: () => lines.join("\n") };
}

let work: string;
let exampleCopy: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "moonbooth-test-"));
  exampleCopy = join(work, "competitor-research");
  await cp(EXAMPLE, exampleCopy, { recursive: true });
});

describe("moonbooth local commands", () => {
  it("pack builds the example and prints its digest", async () => {
    const c = capture();
    const code = await runCli(["pack", exampleCopy], c.io);
    expect(code).toBe(0);
    const manifest = JSON.parse(await readFile(join(exampleCopy, "act.json"), "utf8")) as {
      artifact: { digest: string };
    };
    expect(c.text()).toContain(`Digest: ${manifest.artifact.digest}`);
    const packed = JSON.parse(await readFile(join(work, "competitor-research.act.json"), "utf8")) as {
      format: string;
    };
    expect(packed.format).toBe("act-package");
  });

  it("inspect lists files, tools, and permissions", async () => {
    const c = capture();
    const code = await runCli(["inspect", join(work, "competitor-research.act.json")], c.io);
    expect(code).toBe(0);
    expect(c.text()).toContain("SKILL.md");
    expect(c.text()).toContain("web-search");
    expect(c.text()).toContain("network=true");
    expect(c.text()).toContain("Nothing in the package was executed");
  });

  it("validate passes the example with exit 0", async () => {
    const c = capture();
    expect(await runCli(["validate", exampleCopy], c.io)).toBe(0);
    expect(c.text()).toContain("Valid. Digest:");
  });

  it("validate fails a package with a script file, exit 1 with structured errors", async () => {
    const bad = join(work, "bad-package");
    await cp(exampleCopy, bad, { recursive: true });
    await writeFile(join(bad, "run.sh"), "#!/bin/sh\necho hi\n");
    const c = capture();
    const code = await runCli(["validate", bad], c.io);
    expect(code).toBe(1);
    expect(c.text()).toContain("DISALLOWED_FILE_TYPE");
  });

  it("verify reports per-component outcomes and NOT_TESTED behavioral", async () => {
    const c = capture();
    const code = await runCli(["verify", exampleCopy], c.io);
    expect(code).toBe(0);
    expect(c.text()).toContain("structural: VALIDATED");
    expect(c.text()).toContain("security policy:");
    expect(c.text()).toContain("compatibility: unknown");
    expect(c.text()).toContain("behavioral: NOT_TESTED");
    expect(c.text()).toContain("Overall: VERIFIED");
  });

  it("verify with a profile reports compatibility against it", async () => {
    const profilePath = join(work, "profile.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        adapter_id: "test-env",
        available_tools: ["web-search", "web-fetch"],
        granted_permissions: { network: true, filesystem_write: false, external_side_effects: false },
        configuration: [],
      }),
    );
    const c = capture();
    await runCli(["verify", exampleCopy, "--profile", profilePath], c.io);
    expect(c.text()).toContain("compatibility: compatible");
  });

  it("share without API settings fails with guidance, exit 2", async () => {
    const savedUrl = process.env.ACT_API_URL;
    const savedToken = process.env.ACT_API_TOKEN;
    delete process.env.ACT_API_URL;
    delete process.env.ACT_API_TOKEN;
    try {
      const c = capture();
      const code = await runCli(["share", "transfer-1"], c.io);
      expect(code).toBe(2);
      expect(c.errors.join("\n")).toContain("ACT_API_URL");
    } finally {
      if (savedUrl) process.env.ACT_API_URL = savedUrl;
      if (savedToken) process.env.ACT_API_TOKEN = savedToken;
    }
  });

  it("publish without API settings fails with guidance, exit 2", async () => {
    const savedUrl = process.env.ACT_API_URL;
    const savedToken = process.env.ACT_API_TOKEN;
    delete process.env.ACT_API_URL;
    delete process.env.ACT_API_TOKEN;
    try {
      const c = capture();
      const code = await runCli(["publish", join(work, "competitor-research.act.json")], c.io);
      expect(code).toBe(2);
      expect(c.errors.join("\n")).toContain("ACT_API_URL");
    } finally {
      if (savedUrl) process.env.ACT_API_URL = savedUrl;
      if (savedToken) process.env.ACT_API_TOKEN = savedToken;
    }
  });
});

describe("moonbooth share against a stub API", () => {
  let api: Server;
  let baseUrl: string;

  beforeAll(async () => {
    api = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/links" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { transferId?: string };
          if (parsed.transferId === "t-draft") {
            res.statusCode = 409;
            res.end(
              JSON.stringify({
                error: {
                  code: "needs_approval",
                  message: "This transfer has not been approved yet, so no link was created.",
                  details: { transferId: "t-draft", digest: "sha256:stubdigest", summary: {} },
                },
              }),
            );
          } else {
            res.end(
              JSON.stringify({
                link: {
                  id: "link1",
                  path: "/l/stubtoken",
                  url: "http://localhost:3000/l/stubtoken",
                  expiresAt: "2026-11-28T00:00:00.000Z",
                  status: "active",
                },
                transfer: { id: parsed.transferId, state: "OFFERED" },
              }),
            );
          }
        });
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
      }
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  });

  afterAll(() => api.close());

  it("prints the share URL for an approved transfer", async () => {
    const c = capture();
    const code = await runCli(["share", "t-offered", "--api", baseUrl, "--token", "act_test"], c.io);
    expect(code).toBe(0);
    expect(c.text()).toContain("http://localhost:3000/l/stubtoken");
  });

  it("stops with the digest and the approve step for an unapproved transfer", async () => {
    const c = capture();
    const code = await runCli(["share", "t-draft", "--api", baseUrl, "--token", "act_test"], c.io);
    expect(code).toBe(0);
    expect(c.text()).toContain("STOP");
    expect(c.text()).toContain("sha256:stubdigest");
    expect(c.text()).toContain("moonbooth approve t-draft");
    expect(c.text()).not.toContain("/l/stubtoken");
  });
});

describe("moonbooth booth commands against a stub API", () => {
  let api: Server;
  let baseUrl: string;
  let lastChangesUrl = "";
  let lastBriefUrl = "";
  let lastReplayUrl = "";
  let lastAskUrl = "";
  let lastPublishBody = "";
  let lastCrossBody = "";
  let lastWhatifBody = "";
  let lastCapsuleBody = "";
  let lastStreamLastEventId: string | undefined;
  let lastPublicationMethod = "";
  let lastPublicationBody = "";
  let lastAuth: string | undefined;

  beforeAll(async () => {
    api = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      lastAuth = req.headers.authorization;
      const url = req.url ?? "";
      if (url.startsWith("/api/v1/booths/b1/stream")) {
        lastStreamLastEventId = req.headers["last-event-id"] as string | undefined;
        res.setHeader("content-type", "text/event-stream");
        res.end(
          ": moonbooth stream open\n\n" +
            'event: stream_open\ndata: {"booth":"b1","since":0,"mode":"relevant","latest_seq":1}\n\n' +
            'id: 1\nevent: booth_event\ndata: {"id":"e1","seq":1,"type":"contract","subject":"contract:x","payload":{},"author":{},"in_reply_to":null,"related_ids":null,"created_at":"2026-11-24T00:00:00.000Z","reasons":["subscribed_subject"]}\n\n' +
            'event: stream_end\ndata: {"reason":"lifetime","next_since":1,"latest_seq":1}\n\n',
        );
      } else if (url === "/api/v1/account/booths/b1/publication") {
        lastPublicationMethod = req.method ?? "";
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastPublicationBody = body;
          if (req.method === "PUT") {
            const parsed = JSON.parse(body) as { subjects: string[]; event_types: string[] | null };
            res.end(
              JSON.stringify({
                booth_id: "b1",
                publication: { subjects: parsed.subjects, event_types: parsed.event_types },
              }),
            );
          } else {
            res.end(JSON.stringify({ booth_id: "b1", publication: null }));
          }
        });
      } else if (url.startsWith("/api/v1/booths/b1/changes")) {
        lastChangesUrl = url;
        res.end(
          JSON.stringify({
            events: [{ id: "e1", seq: 1, type: "contract", subject: "contract:x", reasons: ["subscribed:contract:x"] }],
            latest_seq: 1,
            acked_seq: 0,
            next_since: 1,
            subscription: { id: "s1", delivered_cursor: 1, acked_cursor: 0 },
            wake: { poll_after_seconds: 0, long_poll_max_seconds: 25 },
          }),
        );
      } else if (url.startsWith("/api/v1/booths/b1/brief")) {
        lastBriefUrl = url;
        if (url.includes("format=md")) {
          res.end("# Booth brief — b1\n");
        } else {
          res.end(
            JSON.stringify({
              booth: { id: "b1", status: "open", expires_at: "tomorrow" },
              snapshot_seq: 4,
              generated_at: "2026-11-24T00:00:00.000Z",
              filters_applied: {
                participant: "p1",
                subject: null,
                role: null,
                dependency_of: null,
                since: 0,
                max_records: 500,
                max_bytes: 1000000,
              },
              participant: { participant_id: "p1", label: "A", your_ack_seq: 0 },
              sections: { decisions_accepted: [{ id: "e3" }] },
              omitted: {},
            }),
          );
        }
      } else if (url.startsWith("/api/v1/booths/b1/replay")) {
        lastReplayUrl = url;
        res.end(
          JSON.stringify({
            booth: { id: "b1", status: "open", expires_at: "tomorrow" },
            as_of_seq: 2,
            latest_seq: 4,
            filters_applied: { until_seq: 2, subject: null, participant: null },
            causation_note: "Sequence order is not causation.",
            ack_note: "Ack cursors are current values.",
            state: {},
            events: [],
            reached: null,
          }),
        );
      } else if (url.startsWith("/api/v1/booths/b1/ask")) {
        lastAskUrl = url;
        res.end(
          JSON.stringify({
            booth: { id: "b1" },
            query: { subject: "contract:x", type: null, q: null },
            match: { subject: "exact" },
            match_note: "q matches by substring.",
            records: [{ id: "e1", citation: { event_id: "e1", seq: 1, author_label: "A" } }],
            count: 1,
          }),
        );
      } else if (url === "/api/v1/booths/b1/whatif" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastWhatifBody = body;
          res.end(
            JSON.stringify({
              booth: { id: "b1", status: "open" },
              hypothetical: true,
              base_seq: 4,
              evaluated_seq: 6,
              hypothetical_events: [{ event_id: "h1", seq: 5, type: "contract", subject: "contract:api" }],
              delta: {
                new_conflicts: [{ id: "c1", payload: { kind: "contract_conflict" }, hypothetical: true, base_seq: 4 }],
                competing_contracts: [],
                stale_assumptions: [],
                affected_participants: [],
                commitment_status_changes: [],
                check_status_changes: [],
              },
              boundary: "declared dependencies and subject links only",
              note: "Nothing was written.",
              participant_id: "p1",
            }),
          );
        });
      } else if (url === "/api/v1/booths/b1/capsules/preview" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastCapsuleBody = body;
          res.end(
            JSON.stringify({
              booth: { id: "b1" },
              selection: { event_ids: [], subjects: [], sections: ["contracts"] },
              preset: null,
              entries: [{ event_id: "e1", seq: 3, type: "contract", subject: "contract:api", digest: "d".repeat(64) }],
              counts: { events: 1, by_type: { contract: 1 } },
              digest: "a".repeat(64),
              summary_markdown: "# Capsule\n",
              contracts_visible: true,
              note: "stores nothing",
            }),
          );
        });
      } else if (url === "/api/v1/booths/b1/capsules" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastCapsuleBody = body;
          res.end(
            JSON.stringify({
              capsule: {
                id: "cap1",
                source_booth_id: "b1",
                created_by_participant_id: "p1",
                digest: "a".repeat(64),
                created_at: "2026-11-24T00:00:00.000Z",
                manifest: { entries: [] },
                summary_markdown: "# Capsule\n",
              },
            }),
          );
        });
      } else if (url === "/api/v1/booths/b1/capsules/cap1/import" && req.method === "POST") {
        res.end(
          JSON.stringify({
            capsule_id: "cap1",
            origin_booth_id: "b0",
            target_booth_id: "b1",
            imported: [{ origin_event_id: "e1", event_id: "t1", type: "contract", replayed: false }],
            skipped: [{ origin_event_id: "e2", type: "decision_accept", reason: "Endorsement acts do not cross." }],
            note: "new proposals",
          }),
        );
      } else if (url === "/api/v1/booths/b1/capsules/cap1/skill-export" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastCapsuleBody = body;
          res.end(
            JSON.stringify({
              capability: { id: "c1", slug: "demo", name: "Demo" },
              version: { id: "v2", version: "1.0.0", digest: "b".repeat(64) },
              artifact: { id: "a2", storage_key: "packages/v2.json" },
              provenance: { kind: "capsule_skill_export", capsule_id: "cap1" },
              verification_receipt_ids: ["r1"],
            }),
          );
        });
      } else if (url === "/api/v1/booths/b1/signals") {
        res.end(
          JSON.stringify({
            signals: [{ signal_key: "k1", reason: "affected_by_conflict", severity: "high", subject: "contract:x" }],
            latest_seq: 1,
            counts: { pending: 1, acknowledged: 0, dismissed: 0 },
            participant_id: "p1",
          }),
        );
      } else if (url === "/api/v1/booths/b1/checks/check-ev-1") {
        res.end(
          JSON.stringify({
            check_event_id: "check-ev-1",
            seq: 3,
            subject: "check:release",
            title: "Release is verified",
            target: { kind: "booth", commitment_event_id: null, subject: null },
            status: "passed",
            status_reason: null,
            assertions: [
              {
                kind: "evidence_present",
                status: "passed",
                detail: "1 evidence record of kind completion is on the subject.",
                assurance: "self_reported",
                evidence_event_ids: ["ev-9"],
                receipt_id: null,
              },
            ],
            author_participant_id: "p1",
            created_at: "2026-11-24T00:00:00.000Z",
            evaluated_seq: 5,
          }),
        );
      } else if (url === "/api/v1/booths/b1/checks") {
        res.end(
          JSON.stringify({
            checks: [{ check_event_id: "check-ev-1", status: "passed" }],
            latest_seq: 5,
            participant_id: "p1",
          }),
        );
      } else if (url === "/api/v1/booths/b1/watchers" && req.method === "POST") {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            watcher: {
              id: "w1",
              kind: "contract_changed",
              subject: "contract:api",
              version: null,
              window_seconds: null,
              check_event_id: null,
              evidence_kind: null,
              created_at: "2026-11-24T00:00:00.000Z",
            },
            created: true,
            subscription: { id: "s1" },
          }),
        );
      } else if (url === "/api/v1/booths/b1/watchers") {
        res.end(
          JSON.stringify({
            watchers: [{ id: "w1", kind: "contract_changed", subject: "contract:api" }],
            subscription_id: "s1",
            participant_id: "p1",
          }),
        );
      } else if (url === "/api/v1/booths/b1/watchers/w1" && req.method === "DELETE") {
        res.end(JSON.stringify({ revoked: "w1", watchers: [], subscription: { id: "s1" } }));
      } else if (url === "/api/v1/booths/b1/events" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { type?: string; payload?: { title?: string } };
          if (parsed.type !== "check") {
            res.statusCode = 422;
            res.end(JSON.stringify({ error: { code: "invalid_event", message: "stub only takes checks" } }));
            return;
          }
          res.statusCode = 201;
          res.end(JSON.stringify({ event: { id: "check-ev-1", type: "check" }, replayed: false }));
        });
      } else if (url === "/api/v1/booths/b1/publish" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastPublishBody = body;
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              event: {
                id: "evt_pub",
                seq: 9,
                type: "result_published",
                subject: "b1",
                payload: {
                  child_booth_id: "b1",
                  child_url: "https://x/b/b1",
                  events: [
                    { event_id: "e1", seq: 1, type: "note", subject: "s", digest: "d".repeat(64) },
                    { event_id: "e2", seq: 2, type: "note", subject: "s", digest: "d".repeat(64) },
                  ],
                },
              },
              parent: { id: "parent1", url: "https://x/b/parent1" },
              child: { id: "b1" },
              replayed: false,
            }),
          );
        });
      } else if (url === "/api/v1/booths/b1/cross-subscriptions" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastCrossBody = body;
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              subscription: {
                id: "xsub1",
                source_booth_id: "src1",
                destination_booth_id: "b1",
                participant_id: "p1",
                subjects: ["api-contract"],
                event_types: null,
                state: "active",
                created_at: "2026-11-24T00:00:00.000Z",
              },
              created: true,
            }),
          );
        });
      } else if (url === "/api/v1/booths/b1/cross-subscriptions" && req.method === "GET") {
        res.end(JSON.stringify({ subscriptions: [{ id: "xsub1", source_booth_id: "src1" }] }));
      } else if (url === "/api/v1/booths/b1/cross-subscriptions/xsub1" && req.method === "DELETE") {
        res.end(
          JSON.stringify({
            revoked: "xsub1",
            subscription: { id: "xsub1", source_booth_id: "src1", state: "revoked" },
          }),
        );
      } else if (url === "/api/v1/booths/b1/ack" && req.method === "POST") {
        res.end(JSON.stringify({ acked_seq: 1, latest_seq: 1 }));
      } else if (url === "/api/v1/booths/b1/subscriptions") {
        res.end(
          JSON.stringify({
            subscription: { id: "s1", subjects: ["contract:x"], delivery_mode: "poll", delivered_cursor: 1, acked_cursor: 1 },
          }),
        );
      } else if (url === "/api/v1/booths/b1/unlock" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { secret?: string; role?: string };
          if (parsed.secret !== "mbk_test") {
            res.statusCode = 401;
            res.end(
              JSON.stringify({
                error: { code: "admission_failed", message: "The admission secret was not accepted for this booth." },
              }),
            );
            return;
          }
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              role: parsed.role ?? "participant",
              participant_id: "p9",
              credential: "unlocked-cred",
              credential_note: "once",
              admission_method: "generated_key",
              discovery: {},
            }),
          );
        });
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
      }
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  });

  afterAll(() => api.close());

  it("booth publish forwards the parent credential and named events (Phase 8)", async () => {
    const c = capture();
    const code = await runCli(
      [
        "booth", "publish", "b1",
        "--parent-credential", "parent-cred",
        "--events", "e1, e2",
        "--idempotency-key", "pub-1",
        "--api", baseUrl, "--credential", "child-cred",
      ],
      c.io,
    );
    expect(code).toBe(0);
    expect(lastAuth).toBe("Bearer child-cred");
    expect(JSON.parse(lastPublishBody)).toEqual({
      parent_credential: "parent-cred",
      event_ids: ["e1", "e2"],
      idempotency_key: "pub-1",
    });
    expect(c.text()).toContain("Published to parent parent1");
    // Without the parent credential the command refuses before any call.
    const c2 = capture();
    expect(
      await runCli(["booth", "publish", "b1", "--api", baseUrl, "--credential", "child-cred"], c2.io),
    ).toBe(2);
  });

  it("booth cross-subscribe, cross-subscriptions, and cross-unsubscribe (Phase 10)", async () => {
    const c = capture();
    const code = await runCli(
      [
        "booth", "cross-subscribe", "b1",
        "--source", "src1",
        "--source-credential", "src-cred",
        "--subjects", "api-contract, releases",
        "--api", baseUrl, "--credential", "dest-cred",
      ],
      c.io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(lastCrossBody)).toEqual({
      source_booth_id: "src1",
      source_credential: "src-cred",
      subjects: ["api-contract", "releases"],
    });
    expect(c.text()).toContain("Subscribed this booth to src1");

    const list = capture();
    expect(
      await runCli(["booth", "cross-subscriptions", "b1", "--api", baseUrl, "--credential", "dest-cred"], list.io),
    ).toBe(0);
    expect(list.text()).toContain("xsub1");

    const revoke = capture();
    expect(
      await runCli(
        ["booth", "cross-unsubscribe", "b1", "xsub1", "--api", baseUrl, "--credential", "dest-cred"],
        revoke.io,
      ),
    ).toBe(0);
    expect(revoke.text()).toContain("revoked");

    // Without the source credential the command refuses before any call.
    const c2 = capture();
    expect(
      await runCli(
        ["booth", "cross-subscribe", "b1", "--source", "src1", "--api", baseUrl, "--credential", "dest-cred"],
        c2.io,
      ),
    ).toBe(2);
  });

  it("booth changes forwards the wait and prints the feed", async () => {
    const c = capture();
    const code = await runCli(
      ["booth", "changes", "b1", "--since", "0", "--wait", "10", "--api", baseUrl, "--credential", "booth-cred"],
      c.io,
    );
    expect(code).toBe(0);
    expect(lastChangesUrl).toContain("wait_seconds=10");
    expect(lastChangesUrl).toContain("since=0");
    expect(lastAuth?.startsWith("Bearer ")).toBe(true);
    expect(lastAuth?.endsWith("booth-cred")).toBe(true);
    expect(c.text()).toContain("next_since");
    expect(c.text()).toContain("delivered_cursor");
  });

  it("booth stream prints each frame as a JSON line and resumes with the cursor (Phase 13)", async () => {
    const c = capture();
    const code = await runCli(
      ["booth", "stream", "b1", "--since", "0", "--api", baseUrl, "--credential", "booth-cred"],
      c.io,
    );
    expect(code).toBe(0);
    expect(lastStreamLastEventId).toBe("0");
    const lines = c.text().trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((f) => f.type)).toEqual(["open", "event", "end"]);
    expect(lines[1].seq).toBe(1);
    expect(lines[2].next_since).toBe(1);
  });

  it("booths publication reads, sets, and clears the policy (Phase 10)", async () => {
    const c = capture();
    expect(
      await runCli(["booths", "publication", "b1", "--api", baseUrl, "--token", "acct-tok"], c.io),
    ).toBe(0);
    expect(lastPublicationMethod).toBe("GET");
    expect(c.text()).toContain('"publication": null');
    const c2 = capture();
    expect(
      await runCli(
        [
          "booths", "publication", "b1",
          "--subjects", "pricing, contract:api",
          "--event-types", "finding",
          "--api", baseUrl, "--token", "acct-tok",
        ],
        c2.io,
      ),
    ).toBe(0);
    expect(lastPublicationMethod).toBe("PUT");
    expect(JSON.parse(lastPublicationBody)).toEqual({
      subjects: ["pricing", "contract:api"],
      event_types: ["finding"],
    });
    expect(c2.text()).toContain('"subjects"');
    const c3 = capture();
    expect(
      await runCli(
        ["booths", "publication", "b1", "--clear", "--api", baseUrl, "--token", "acct-tok"],
        c3.io,
      ),
    ).toBe(0);
    expect(lastPublicationMethod).toBe("DELETE");
  });

  it("booth brief, replay, and ask forward their filters and print the read models (Phase 4)", async () => {
    const c = capture();
    expect(
      await runCli(
        ["booth", "brief", "b1", "--subject", "contract:api", "--max-records", "10", "--api", baseUrl, "--credential", "booth-cred"],
        c.io,
      ),
    ).toBe(0);
    expect(lastBriefUrl).toContain("subject=contract%3Aapi");
    expect(lastBriefUrl).toContain("max_records=10");
    expect(c.text()).toContain("snapshot_seq");

    const cMd = capture();
    expect(
      await runCli(["booth", "brief", "b1", "--format", "md", "--api", baseUrl, "--credential", "booth-cred"], cMd.io),
    ).toBe(0);
    expect(lastBriefUrl).toContain("format=md");
    expect(cMd.text()).toContain("# Booth brief — b1");

    const c2 = capture();
    expect(
      await runCli(["booth", "replay", "b1", "--until", "2", "--api", baseUrl, "--credential", "booth-cred"], c2.io),
    ).toBe(0);
    expect(lastReplayUrl).toContain("until_seq=2");
    expect(c2.text()).toContain("as_of_seq");

    const c3 = capture();
    expect(
      await runCli(["booth", "ask", "b1", "--subject", "contract:x", "--api", baseUrl, "--credential", "booth-cred"], c3.io),
    ).toBe(0);
    expect(lastAskUrl).toContain("subject=contract%3Ax");
    expect(c3.text()).toContain("citation");

    // Ask with no lookup parameter is a usage error, exit 2.
    const c4 = capture();
    expect(await runCli(["booth", "ask", "b1", "--api", baseUrl, "--credential", "booth-cred"], c4.io)).toBe(2);
  });

  it("booth whatif forwards the events and base point and prints the delta (Phase 11)", async () => {
    const c = capture();
    expect(
      await runCli(
        [
          "booth", "whatif", "b1",
          "--events", JSON.stringify([{ type: "contract", subject: "contract:api", payload: { version: "v2" } }]),
          "--at-seq", "4",
          "--api", baseUrl, "--credential", "booth-cred",
        ],
        c.io,
      ),
    ).toBe(0);
    expect(JSON.parse(lastWhatifBody)).toEqual({
      events: [{ type: "contract", subject: "contract:api", payload: { version: "v2" } }],
      at_seq: 4,
    });
    expect(c.text()).toContain("new_conflicts");
    expect(c.text()).toContain("contract_conflict");

    // No --events is a usage error, exit 2; a non-array --events is too.
    const c2 = capture();
    expect(await runCli(["booth", "whatif", "b1", "--api", baseUrl, "--credential", "booth-cred"], c2.io)).toBe(2);
    const c3 = capture();
    expect(
      await runCli(["booth", "whatif", "b1", "--events", "{}", "--api", baseUrl, "--credential", "booth-cred"], c3.io),
    ).toBe(2);
  });

  it("booth capsule commands preview, create, import, and export skills (Phase 12)", async () => {
    const selection = JSON.stringify({ sections: ["contracts"] });
    const c = capture();
    expect(
      await runCli(
        ["booth", "capsule-preview", "b1", "--selection", selection, "--api", baseUrl, "--credential", "booth-cred"],
        c.io,
      ),
    ).toBe(0);
    expect(JSON.parse(lastCapsuleBody)).toEqual({ selection: { sections: ["contracts"] } });
    expect(c.text()).toContain("summary_markdown");

    const c2 = capture();
    expect(
      await runCli(
        [
          "booth", "capsule-create", "b1",
          "--selection", selection,
          "--expected-digest", "a".repeat(64),
          "--api", baseUrl, "--credential", "booth-cred",
        ],
        c2.io,
      ),
    ).toBe(0);
    expect(JSON.parse(lastCapsuleBody)).toEqual({
      selection: { sections: ["contracts"] },
      expected_digest: "a".repeat(64),
    });
    expect(c2.text()).toContain("cap1");

    const c3 = capture();
    expect(
      await runCli(
        ["booth", "capsule-import", "b1", "--capsule", "cap1", "--api", baseUrl, "--credential", "booth-cred"],
        c3.io,
      ),
    ).toBe(0);
    expect(c3.text()).toContain("decision_accept");
    expect(c3.errors.join("\n")).toContain("pre-endorsed");

    const c4 = capture();
    expect(
      await runCli(
        [
          "booth", "capsule-export-skill", "b1",
          "--capsule", "cap1", "--version-id", "v1",
          "--api", baseUrl, "--credential", "booth-cred",
        ],
        c4.io,
      ),
    ).toBe(0);
    expect(JSON.parse(lastCapsuleBody)).toEqual({ version_id: "v1" });
    expect(c4.text()).toContain("verification_receipt_ids");

    // Preview with neither a selection nor a preset is a usage error.
    const c5 = capture();
    expect(
      await runCli(["booth", "capsule-preview", "b1", "--api", baseUrl, "--credential", "booth-cred"], c5.io),
    ).toBe(2);
  });

  it("booth check declares, and checks / check-result print computed results (Phase 5)", async () => {
    const c = capture();
    expect(
      await runCli(
        [
          "booth", "check", "b1",
          "--title", "Release is verified",
          "--subject", "check:release",
          "--assertions", JSON.stringify([{ kind: "evidence_present", evidence_kind: "completion", subject: "work:release" }]),
          "--api", baseUrl, "--credential", "booth-cred",
        ],
        c.io,
      ),
    ).toBe(0);
    expect(c.text()).toContain("check-ev-1");

    const c2 = capture();
    expect(await runCli(["booth", "checks", "b1", "--api", baseUrl, "--credential", "booth-cred"], c2.io)).toBe(0);
    expect(c2.text()).toContain("\"passed\"");

    const c3 = capture();
    expect(
      await runCli(["booth", "check-result", "b1", "check-ev-1", "--api", baseUrl, "--credential", "booth-cred"], c3.io),
    ).toBe(0);
    expect(c3.text()).toContain("self_reported");
    expect(c3.text()).toContain("evaluated_seq");

    // Declaring without a title is a usage error, exit 2.
    const c4 = capture();
    expect(await runCli(["booth", "check", "b1", "--api", baseUrl, "--credential", "booth-cred"], c4.io)).toBe(2);
    // Malformed assertions JSON is a usage error, exit 2.
    const c5 = capture();
    expect(
      await runCli(
        ["booth", "check", "b1", "--title", "T", "--assertions", "{}", "--api", baseUrl, "--credential", "booth-cred"],
        c5.io,
      ),
    ).toBe(2);
  });

  it("booth watch declares, watchers lists, and unwatch revokes (Phase 6)", async () => {
    const c = capture();
    expect(
      await runCli(
        ["booth", "watch", "b1", "--kind", "contract_changed", "--subject", "contract:api", "--api", baseUrl, "--credential", "booth-cred"],
        c.io,
      ),
    ).toBe(0);
    expect(c.text()).toContain("\"w1\"");
    expect(c.text()).toContain("contract_changed");

    const c2 = capture();
    expect(await runCli(["booth", "watchers", "b1", "--api", baseUrl, "--credential", "booth-cred"], c2.io)).toBe(0);
    expect(c2.text()).toContain("contract:api");

    const c3 = capture();
    expect(await runCli(["booth", "unwatch", "b1", "w1", "--api", baseUrl, "--credential", "booth-cred"], c3.io)).toBe(0);
    expect(c3.text()).toContain("revoked");

    // Declaring without a kind is a usage error, exit 2.
    const c4 = capture();
    expect(await runCli(["booth", "watch", "b1", "--api", baseUrl, "--credential", "booth-cred"], c4.io)).toBe(2);
    // Unwatch without a watcher id is a usage error, exit 2.
    const c5 = capture();
    expect(await runCli(["booth", "unwatch", "b1", "--api", baseUrl, "--credential", "booth-cred"], c5.io)).toBe(2);
  });

  it("booth signals prints pending signals with severities", async () => {
    const c = capture();
    const code = await runCli(["booth", "signals", "b1", "--api", baseUrl, "--credential", "booth-cred"], c.io);
    expect(code).toBe(0);
    expect(c.text()).toContain("affected_by_conflict");
    expect(c.text()).toContain("\"high\"");
  });

  it("booth ack posts the sequence; booth subscriptions reads the resource", async () => {
    const c = capture();
    expect(
      await runCli(["booth", "ack", "b1", "--seq", "1", "--api", baseUrl, "--credential", "booth-cred"], c.io),
    ).toBe(0);
    expect(c.text()).toContain("acked_seq");
    const c2 = capture();
    expect(
      await runCli(["booth", "subscriptions", "b1", "--api", baseUrl, "--credential", "booth-cred"], c2.io),
    ).toBe(0);
    expect(c2.text()).toContain("contract:x");
  });

  it("booth commands refuse without a credential, exit 2 with guidance", async () => {
    const c = capture();
    const code = await runCli(["booth", "changes", "b1", "--api", baseUrl], c.io);
    expect(code).toBe(2);
    expect(c.errors.join("\n")).toContain("booth credential is required");
  });

  it("booth unlock exchanges the admission secret and prints the credential once", async () => {
    const c = capture();
    const code = await runCli(
      ["booth", "unlock", "b1", "--secret", "mbk_test", "--role", "recipient", "--api", baseUrl],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.text()).toContain("unlocked-cred");
    expect(c.text()).toContain("generated_key");
    expect(c.errors.join("\n")).toContain("not stored by this tool");
  });

  it("booth unlock surfaces the uniform admission refusal and refuses without a secret", async () => {
    const c = capture();
    const code = await runCli(
      ["booth", "unlock", "b1", "--secret", "mbk_wrong", "--api", baseUrl],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.errors.join("\n")).toContain("admission_failed");
    const c2 = capture();
    const code2 = await runCli(["booth", "unlock", "b1", "--api", baseUrl], c2.io);
    expect(code2).toBe(2);
    expect(c2.errors.join("\n")).toContain("admission secret is required");
  });
});

describe("moonbooth webhooks against a stub API", () => {
  let api: Server;
  let baseUrl: string;
  const bodies: Array<{ method: string; url: string; body: string }> = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        bodies.push({ method: req.method ?? "", url: req.url ?? "", body });
        if (req.url === "/api/v1/webhooks" && req.method === "POST") {
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              webhook: {
                id: "w1",
                url: "https://receiver.example/hook",
                scope: "account",
                booth_id: null,
                event_types: ["finding"],
                status: "active",
                last_delivery_at: null,
                created_at: "2026-11-24T00:00:00.000Z",
                updated_at: "2026-11-24T00:00:00.000Z",
                paused_at: null,
              },
              secret: "mbw_cli_secret",
            }),
          );
        } else if (req.url === "/api/v1/webhooks" && req.method === "GET") {
          res.end(JSON.stringify({ webhooks: [] }));
        } else if (req.url === "/api/v1/webhooks/w1/test" && req.method === "POST") {
          res.statusCode = 202;
          res.end(JSON.stringify({ delivery_id: "d-test-1" }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
        }
      });
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  });

  afterAll(() => api.close());

  it("creates a webhook and prints the one-time secret", async () => {
    const c = capture();
    const code = await runCli(
      ["webhooks", "create", "https://receiver.example/hook", "--events", "finding,conflict", "--api", baseUrl, "--token", "act_test"],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.text()).toContain("mbw_cli_secret");
    expect(c.text()).toContain("shown once");
    const posted = bodies.find((b) => b.method === "POST" && b.url === "/api/v1/webhooks");
    expect(JSON.parse(posted!.body)).toEqual({
      url: "https://receiver.example/hook",
      event_types: ["finding", "conflict"],
    });
  });

  it("lists webhooks and queues a test delivery", async () => {
    const c = capture();
    expect(await runCli(["webhooks", "list", "--api", baseUrl, "--token", "act_test"], c.io)).toBe(0);
    expect(c.text()).toContain("No webhooks.");
    const c2 = capture();
    expect(await runCli(["webhooks", "test", "w1", "--api", baseUrl, "--token", "act_test"], c2.io)).toBe(0);
    expect(c2.text()).toContain("d-test-1");
  });
});
