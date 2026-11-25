import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { ActClient, ActApiError, BoothClient, createBooth } from "../src/index.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function mockFetch(handler: (call: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    const out = handler(call);
    return new Response(JSON.stringify(out.json), {
      status: out.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchFn };
}

describe("ActClient", () => {
  it("sends the bearer token and hits the capability routes", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/capabilities") && call.method === "POST") {
        return {
          status: 201,
          json: {
            capability: { id: "c1", slug: "s", name: "S", description: "d" },
            version: { id: "v1", version: "1.0.0", digest: "abc" },
            artifactId: "a1",
            blocked: false,
            scanFindings: [],
          },
        };
      }
      return { status: 200, json: { capabilities: [] } };
    });
    const client = new ActClient({ baseUrl: "https://act.example/", token: "act_test", fetchFn });
    const created = await client.createCapability({
      mode: "paste",
      name: "S",
      description: "d",
      content: "steps",
    });
    expect(created.version.digest).toBe("abc");
    expect(calls[0].url).toBe("https://act.example/api/v1/capabilities");
    expect(calls[0].headers.authorization).toBe("Bearer act_test");
    expect(JSON.parse(calls[0].body).mode).toBe("paste");
    await client.listCapabilities();
    expect(calls[1].method).toBe("GET");
    expect(calls[1].headers.authorization).toBe("Bearer act_test");
  });

  it("approve passes the digest in the body", async () => {
    const { calls, fetchFn } = mockFetch(() => ({
      status: 200,
      json: {
        transfer: { id: "t1", state: "OFFERED" },
        invitation: { token: "tok", path: "/invite/tok", expiresAt: "2030-01-01" },
      },
    }));
    const client = new ActClient({ baseUrl: "http://x", token: "act_t", fetchFn });
    const out = await client.approveTransfer("t1", "deadbeef");
    expect(out.invitation.token).toBe("tok");
    expect(calls[0].url).toBe("http://x/api/v1/transfers/t1/approve");
    expect(JSON.parse(calls[0].body)).toEqual({ digest: "deadbeef" });
  });

  it("maps API errors to ActApiError with the code", async () => {
    const { fetchFn } = mockFetch(() => ({
      status: 403,
      json: { error: { code: "forbidden", message: "You are not part of this transfer." } },
    }));
    const client = new ActClient({ baseUrl: "http://x", token: "act_t", fetchFn });
    const err = await client.getTransfer("t9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActApiError);
    expect((err as ActApiError).code).toBe("forbidden");
    expect((err as ActApiError).status).toBe(403);
  });

  it("runs against a real local HTTP server", async () => {
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/transfers/t1") {
        res.end(JSON.stringify({ transfer: { id: "t1", state: "DRAFT" } }));
      } else if (req.url?.startsWith("/api/v1/invitations/")) {
        res.end(JSON.stringify({ offer: { transferId: "t1", state: "OFFERED" } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "Nope." } }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const client = new ActClient({ baseUrl: `http://127.0.0.1:${port}`, token: "act_live" });
      const t = await client.getTransfer("t1");
      expect(t.transfer.state).toBe("DRAFT");
      const offer = await client.getOffer("tok123");
      expect(offer.offer.transferId).toBe("t1");
      expect(seen[0]).toContain("Bearer act_live");
      await expect(client.getReceipt("nope")).rejects.toMatchObject({ code: "not_found" });
    } finally {
      server.close();
    }
  });
});

describe("BoothClient", () => {
  it("creates a booth anonymously, joins, and sends the booth credential afterwards", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/booths") && call.method === "POST") {
        return {
          status: 201,
          json: { id: "booth1", url: "https://x/b/booth1", expires_at: "tomorrow", creator_credential: "cc" },
        };
      }
      if (call.url.endsWith("/api/v1/booths/booth1/join")) {
        return {
          status: 201,
          json: { role: "participant", participant_id: "p1", credential: "booth-cred", credential_note: "once", discovery: {} },
        };
      }
      if (call.url.includes("/api/v1/booths/booth1/changes")) {
        return {
          status: 200,
          json: {
            events: [],
            latest_seq: 3,
            acked_seq: 0,
            next_since: 0,
            subscription: { id: "s1", delivered_cursor: 0, acked_cursor: 0 },
            wake: { poll_after_seconds: 5, long_poll_max_seconds: 25 },
          },
        };
      }
      return { status: 200, json: {} };
    });

    const created = await createBooth("https://act.example/", {}, fetchFn);
    expect(created.id).toBe("booth1");
    // Booth creation is anonymous: no authorization header at all.
    expect(calls[0].headers.authorization).toBeUndefined();

    const booth = new BoothClient({ baseUrl: "https://act.example/", boothId: created.id, fetchFn });
    const joined = await booth.joinParticipant({ name: "Agent" });
    expect(joined.participant_id).toBe("p1");
    expect(booth.currentCredential).toBe("booth-cred");
    expect(JSON.parse(calls[1].body).role).toBe("participant");

    const changes = await booth.getChanges({ since: 0, waitSeconds: 10 });
    expect(changes.wake.long_poll_max_seconds).toBe(25);
    // After the join, calls carry the booth credential, and the wait
    // is forwarded as wait_seconds.
    expect(calls[2].headers.authorization).toBe("Bearer " + "booth-cred");
    expect(calls[2].url).toContain("wait_seconds=10");
    expect(calls[2].url).toContain("since=0");
  });

  it("reads and answers signals at the signal endpoints", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/signals") && call.method === "GET") {
        return {
          status: 200,
          json: {
            signals: [
              {
                signal_key: "k1",
                source_event_id: "e1",
                subject: "contract:x",
                participant_id: "p1",
                reason: "affected_by_conflict",
                severity: "high",
                state_ref: 2,
                created_from_seq: 2,
              },
            ],
            latest_seq: 2,
            counts: { pending: 1, acknowledged: 0, dismissed: 0 },
            participant_id: "p1",
          },
        };
      }
      if (call.url.endsWith("/signals/k1/ack")) {
        return { status: 200, json: { signal_key: "k1", state: "acknowledged", signal: {} } };
      }
      if (call.url.endsWith("/subscriptions") && call.method === "GET") {
        return { status: 200, json: { subscription: { id: "s1", subjects: ["contract:x"], delivered_cursor: 2, acked_cursor: 0 } } };
      }
      return { status: 200, json: {} };
    });
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "b1",
      credential: "booth-cred",
      fetchFn,
    });
    const view = await booth.listSignals();
    expect(view.signals[0].severity).toBe("high");
    const acked = await booth.ackSignal("k1");
    expect(acked.state).toBe("acknowledged");
    const sub = await booth.getSubscription();
    expect(sub.subscription.subjects).toEqual(["contract:x"]);
    expect(calls.every((c) => c.headers.authorization === "Bearer " + "booth-cred")).toBe(true);
  });

  it("declares, lists, and revokes watchers at the watcher endpoints", async () => {
    const watcher = {
      id: "w1",
      kind: "contract_changed",
      subject: "contract:x",
      version: null,
      window_seconds: null,
      check_event_id: null,
      evidence_kind: null,
      created_at: "2026-11-24T00:00:00.000Z",
    };
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/watchers") && call.method === "POST") {
        return { status: 201, json: { watcher, created: true, subscription: { id: "s1", conditions: [watcher] } } };
      }
      if (call.url.endsWith("/watchers") && call.method === "GET") {
        return { status: 200, json: { watchers: [watcher], subscription_id: "s1", participant_id: "p1" } };
      }
      if (call.url.endsWith("/watchers/w1") && call.method === "DELETE") {
        return { status: 200, json: { revoked: "w1", watchers: [], subscription: { id: "s1", conditions: [] } } };
      }
      return { status: 200, json: {} };
    });
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "b1",
      credential: "booth-cred",
      fetchFn,
    });
    const created = await booth.createWatcher({ kind: "contract_changed", subject: "contract:x" });
    expect(created.created).toBe(true);
    expect(created.watcher.id).toBe("w1");
    expect(JSON.parse(calls[0].body)).toEqual({
      condition: { kind: "contract_changed", subject: "contract:x" },
    });
    const listed = await booth.listWatchers();
    expect(listed.watchers).toHaveLength(1);
    expect(listed.watchers[0].kind).toBe("contract_changed");
    const revoked = await booth.revokeWatcher("w1");
    expect(revoked.revoked).toBe("w1");
    expect(revoked.watchers).toEqual([]);
    expect(calls.every((c) => c.headers.authorization === "Bearer " + "booth-cred")).toBe(true);
  });

  it("unlocks a locked booth and carries the minted credential afterwards", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/booths/locked1/unlock") && call.method === "POST") {
        return {
          status: 201,
          json: {
            role: "recipient",
            participant_id: "p9",
            credential: "unlocked-cred",
            credential_note: "once",
            admission_method: "generated_key",
            discovery: {},
          },
        };
      }
      if (call.url.endsWith("/api/v1/booths/locked1/state")) {
        return { status: 200, json: { booth: { id: "locked1" } } };
      }
      return { status: 200, json: {} };
    });
    const booth = new BoothClient({ baseUrl: "https://act.example", boothId: "locked1", fetchFn });
    const unlocked = await booth.unlock({ secret: "mbk_test", role: "recipient" });
    expect(unlocked.admission_method).toBe("generated_key");
    expect(booth.currentCredential).toBe("unlocked-cred");
    // The unlock call itself sends the secret in the body and no
    // authorization header; later calls carry the minted credential.
    expect(JSON.parse(calls[0].body)).toEqual({ secret: "mbk_test", role: "recipient" });
    expect(calls[0].headers.authorization).toBeUndefined();
    await booth.getState();
    expect(calls[1].headers.authorization).toBe("Bearer " + "unlocked-cred");
  });

  it("creates a locked booth with the access object and surfaces the admission secret", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/booths") && call.method === "POST") {
        return {
          status: 201,
          json: {
            id: "locked2",
            url: "https://x/b/locked2",
            expires_at: "tomorrow",
            access: { mode: "locked" },
            admission_method: "generated_key",
            admission_secret: "mbk_once",
          },
        };
      }
      return { status: 200, json: {} };
    });
    const created = await createBooth(
      "https://act.example",
      { access: { mode: "locked", method: "generated_key" } },
      fetchFn,
    );
    expect(created.admission_secret).toBe("mbk_once");
    expect(JSON.parse(calls[0].body).access).toEqual({ mode: "locked", method: "generated_key" });
  });

  it("creates a child booth and publishes results to its parent (Phase 8)", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/booths") && call.method === "POST") {
        return {
          status: 201,
          json: {
            id: "child1",
            url: "https://x/b/child1",
            expires_at: "tomorrow",
            parent: { id: "parent1", url: "https://x/b/child1" },
          },
        };
      }
      if (call.url.endsWith("/api/v1/booths/child1/publish")) {
        return {
          status: 201,
          json: {
            event: {
              id: "evt_pub",
              seq: 9,
              type: "result_published",
              subject: "child1",
              payload: {
                child_booth_id: "child1",
                child_url: "https://x/b/child1",
                events: [{ event_id: "e1", seq: 3, type: "decision", subject: "s", digest: "d".repeat(64) }],
                receipt: { receipt_id: "rcpt_1", receipt_digest: "e".repeat(64) },
              },
            },
            parent: { id: "parent1", url: "https://x/b/parent1" },
            child: { id: "child1" },
            replayed: false,
          },
        };
      }
      return { status: 200, json: {} };
    });

    const created = await createBooth(
      "https://act.example",
      { ttlSeconds: 900, parent: { boothId: "@acme/engineering", credential: "parent-cred" } },
      fetchFn,
    );
    expect(created.parent).toEqual({ id: "parent1", url: "https://x/b/child1" });
    expect(JSON.parse(calls[0].body).parent).toEqual({
      booth_id: "@acme/engineering",
      credential: "parent-cred",
    });

    const child = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "child1",
      credential: "child-cred",
      fetchFn,
    });
    const published = await child.publishResult({
      parentCredential: "parent-cred",
      eventIds: ["e1"],
      receiptId: "rcpt_1",
      idempotencyKey: "pub-1",
    });
    expect(published.event.id).toBe("evt_pub");
    expect(published.parent.id).toBe("parent1");
    expect(published.event.payload.receipt?.receipt_id).toBe("rcpt_1");
    expect(calls[1].headers.authorization).toBe("Bearer child-cred");
    expect(JSON.parse(calls[1].body)).toEqual({
      parent_credential: "parent-cred",
      event_ids: ["e1"],
      receipt_id: "rcpt_1",
      idempotency_key: "pub-1",
    });
  });

  it("creates, lists, and revokes cross-booth subscriptions (Phase 10)", async () => {
    const subscription = {
      id: "sub1",
      source_booth_id: "src1",
      destination_booth_id: "booth1",
      participant_id: "p1",
      subjects: ["api-contract"],
      event_types: null,
      state: "active",
      created_at: "2026-11-24T00:00:00.000Z",
    };
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.includes("/cross-subscriptions") && call.method === "POST") {
        return { status: 201, json: { subscription, created: true } };
      }
      if (call.url.includes("/cross-subscriptions") && call.method === "GET") {
        return { status: 200, json: { subscriptions: [subscription] } };
      }
      if (call.url.includes("/cross-subscriptions/sub1") && call.method === "DELETE") {
        return { status: 200, json: { revoked: "sub1", subscription: { ...subscription, state: "revoked" } } };
      }
      return { status: 404, json: { error: { code: "not_found", message: "nope" } } };
    });

    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "booth1",
      credential: "dest-cred",
      fetchFn,
    });
    const created = await booth.createCrossSubscription({
      sourceBoothId: "src1",
      sourceCredential: "src-cred",
      subjects: ["api-contract"],
    });
    expect(created.created).toBe(true);
    expect(created.subscription.source_booth_id).toBe("src1");
    expect(calls[0].url).toContain("/api/v1/booths/booth1/cross-subscriptions");
    expect(JSON.parse(calls[0].body)).toEqual({
      source_booth_id: "src1",
      source_credential: "src-cred",
      subjects: ["api-contract"],
    });

    const listed = await booth.listCrossSubscriptions();
    expect(listed.subscriptions).toHaveLength(1);

    const revoked = await booth.revokeCrossSubscription("sub1");
    expect(revoked.subscription.state).toBe("revoked");
  });

  it("evaluates a what-if at the whatif endpoint (Phase 11)", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.includes("/api/v1/booths/booth1/whatif") && call.method === "POST") {
        return {
          status: 200,
          json: {
            booth: { id: "booth1", status: "open" },
            hypothetical: true,
            base_seq: 8,
            evaluated_seq: 10,
            hypothetical_events: [
              { event_id: "h1", seq: 9, type: "contract", subject: "contract:api" },
            ],
            delta: {
              new_conflicts: [{ id: "c1", payload: { kind: "contract_conflict" }, hypothetical: true, base_seq: 8 }],
              competing_contracts: [{ subject: "contract:api", versions: [], hypothetical: true, base_seq: 8 }],
              stale_assumptions: [],
              affected_participants: [{ participant_id: "p1", label: "A", reasons: ["affected_by_conflict"], hypothetical: true, base_seq: 8 }],
              commitment_status_changes: [],
              check_status_changes: [{ check_event_id: "k1", from_status: "passed", to_status: "failed", hypothetical: true, base_seq: 8 }],
            },
            boundary: "The impact graph covers declared dependencies and subject links only.",
            note: "Nothing was written.",
            participant_id: "p1",
          },
        };
      }
      return { status: 404, json: { error: { code: "not_found", message: "nope" } } };
    });
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "booth1",
      credential: "cred-1",
      fetchFn,
    });
    const result = await booth.evaluateWhatIf({
      events: [{ type: "contract", subject: "contract:api", payload: { version: "v2" } }],
      atSeq: 8,
    });
    expect(result.hypothetical).toBe(true);
    expect(result.base_seq).toBe(8);
    expect(result.delta.new_conflicts).toHaveLength(1);
    expect(result.delta.check_status_changes[0]?.to_status).toBe("failed");
    expect(calls[0].url).toContain("/api/v1/booths/booth1/whatif");
    expect(calls[0].headers.authorization).toBe("Bearer cred-1");
    expect(JSON.parse(calls[0].body)).toEqual({
      events: [{ type: "contract", subject: "contract:api", payload: { version: "v2" } }],
      at_seq: 8,
    });
  });

  it("previews, creates, imports, and skill-exports capsules at the capsule endpoints (Phase 12)", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.includes("/capsules/preview")) {
        return {
          status: 200,
          json: {
            booth: { id: "booth1" },
            selection: { event_ids: [], subjects: [], sections: ["contracts"] },
            preset: null,
            entries: [{ event_id: "e1", seq: 3, type: "contract", subject: "contract:api", digest: "d".repeat(64) }],
            counts: { events: 1, by_type: { contract: 1 } },
            digest: "a".repeat(64),
            summary_markdown: "# Capsule\n",
            contracts_visible: true,
            note: "stores nothing",
          },
        };
      }
      if (call.url.includes("/capsules/cap1/import")) {
        return {
          status: 201,
          json: {
            capsule_id: "cap1",
            origin_booth_id: "booth0",
            target_booth_id: "booth1",
            imported: [{ origin_event_id: "e1", event_id: "t1", type: "contract", replayed: false }],
            skipped: [{ origin_event_id: "e2", type: "decision_accept", reason: "Endorsement acts do not cross." }],
            note: "new proposals",
          },
        };
      }
      if (call.url.includes("/capsules/cap1/skill-export")) {
        return {
          status: 201,
          json: {
            capability: { id: "c1", slug: "demo", name: "Demo" },
            version: { id: "v2", version: "1.0.0", digest: "b".repeat(64) },
            artifact: { id: "a2", storage_key: "packages/v2.json" },
            provenance: { kind: "capsule_skill_export", capsule_id: "cap1" },
            verification_receipt_ids: ["r1"],
          },
        };
      }
      if (call.url.endsWith("/capsules")) {
        return {
          status: 201,
          json: {
            capsule: {
              id: "cap1",
              source_booth_id: "booth1",
              created_by_participant_id: "p1",
              digest: "a".repeat(64),
              created_at: "2026-11-24T00:00:00.000Z",
              manifest: { entries: [] },
              summary_markdown: "# Capsule\n",
            },
          },
        };
      }
      return { status: 404, json: { error: { code: "not_found", message: "nope" } } };
    });
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "booth1",
      credential: "cred-1",
      fetchFn,
    });
    const preview = await booth.previewCapsule({ selection: { sections: ["contracts"] } });
    expect(preview.digest).toBe("a".repeat(64));
    expect(JSON.parse(calls[0].body)).toEqual({ selection: { sections: ["contracts"] } });
    const created = await booth.createCapsule({
      selection: { sections: ["contracts"] },
      expectedDigest: preview.digest,
    });
    expect(created.id).toBe("cap1");
    expect(JSON.parse(calls[1].body)).toEqual({
      selection: { sections: ["contracts"] },
      expected_digest: "a".repeat(64),
    });
    const imported = await booth.importCapsule("cap1");
    expect(imported.imported[0].event_id).toBe("t1");
    expect(imported.skipped[0].type).toBe("decision_accept");
    expect(calls[2].url).toContain("/api/v1/booths/booth1/capsules/cap1/import");
    const exported = await booth.exportCapsuleSkill("cap1", { versionId: "v1" });
    expect(exported.version.id).toBe("v2");
    expect(exported.verification_receipt_ids).toEqual(["r1"]);
    expect(JSON.parse(calls[3].body)).toEqual({ version_id: "v1" });
  });

  it("reads the brief, the replay, and ask at the read-model endpoints (Phase 4)", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.includes("/api/v1/booths/booth1/brief")) {
        return {
          status: 200,
          json: {
            booth: { id: "booth1", status: "open", expires_at: "tomorrow" },
            snapshot_seq: 7,
            generated_at: "2026-11-24T00:00:00.000Z",
            filters_applied: {
              participant: "p1",
              subject: "contract:api",
              role: null,
              dependency_of: null,
              since: 0,
              max_records: 500,
              max_bytes: 1000000,
            },
            participant: { participant_id: "p1", label: "A", your_ack_seq: 0 },
            sections: { decisions_accepted: [{ id: "e5" }] },
            omitted: {},
          },
        };
      }
      if (call.url.includes("/api/v1/booths/booth1/replay")) {
        return {
          status: 200,
          json: {
            booth: { id: "booth1", status: "open", expires_at: "tomorrow" },
            as_of_seq: 2,
            latest_seq: 7,
            filters_applied: { until_seq: 2, subject: null, participant: null },
            causation_note: "Sequence order is not causation.",
            ack_note: "Ack cursors are current values.",
            state: {},
            events: [],
            reached: null,
          },
        };
      }
      if (call.url.includes("/api/v1/booths/booth1/ask")) {
        return {
          status: 200,
          json: {
            booth: { id: "booth1" },
            query: { subject: "contract:api", type: null, q: null },
            match: { subject: "exact" },
            match_note: "q matches by substring.",
            records: [
              {
                id: "e1",
                citation: { event_id: "e1", seq: 1, author_label: "A" },
              },
            ],
            count: 1,
          },
        };
      }
      return { status: 200, json: {} };
    });
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "booth1",
      credential: "booth-cred",
      fetchFn,
    });

    const brief = await booth.getBrief({ subject: "contract:api", maxRecords: 10 });
    expect(brief.snapshot_seq).toBe(7);
    expect(brief.sections.decisions_accepted[0]!.id).toBe("e5");
    expect(calls[0].url).toContain("/brief?");
    expect(calls[0].url).toContain("subject=contract%3Aapi");
    expect(calls[0].url).toContain("max_records=10");
    expect(calls[0].headers.authorization).toBe("Bearer booth-cred");

    const replay = await booth.getReplay({ untilSeq: 2 });
    expect(replay.as_of_seq).toBe(2);
    expect(replay.reached).toBeNull();
    expect(calls[1].url).toContain("/replay?");
    expect(calls[1].url).toContain("until_seq=2");

    const answer = await booth.ask({ subject: "contract:api" });
    expect(answer.count).toBe(1);
    expect(answer.records[0]!.citation.author_label).toBe("A");
    expect(calls[2].url).toContain("/ask?");
    expect(calls[2].url).toContain("subject=contract%3Aapi");
  });

  it("declares a check and reads computed results at the checks endpoints (Phase 5)", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.includes("/api/v1/booths/booth1/checks/check-ev-1")) {
        return {
          status: 200,
          json: {
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
          },
        };
      }
      if (call.url.includes("/api/v1/booths/booth1/checks")) {
        return {
          status: 200,
          json: {
            checks: [{ check_event_id: "check-ev-1", status: "passed" }],
            latest_seq: 5,
            participant_id: "p1",
          },
        };
      }
      if (call.url.endsWith("/api/v1/booths/booth1/events")) {
        return { status: 201, json: { event: { id: "check-ev-1", type: "check" }, replayed: false } };
      }
      return { status: 200, json: {} };
    });
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "booth1",
      credential: "booth-cred",
      fetchFn,
    });
    const declared = await booth.declareCheck({
      title: "Release is verified",
      subject: "check:release",
      assertions: [
        { kind: "evidence_present", evidence_kind: "completion", subject: "work:release" },
      ],
    });
    expect(declared.event.id).toBe("check-ev-1");
    const sent = JSON.parse(calls[0].body);
    expect(sent.type).toBe("check");
    expect(sent.subject).toBe("check:release");
    expect(sent.payload.assertions[0].evidence_kind).toBe("completion");

    const list = await booth.listChecks();
    expect(list).toHaveLength(1);
    expect(calls[1].method).toBe("GET");
    expect(calls[1].url).toContain("/checks");

    const result = await booth.getCheck("check-ev-1");
    expect(result.status).toBe("passed");
    expect(result.assertions[0].assurance).toBe("self_reported");
    expect(result.evaluated_seq).toBe(5);
    expect(calls[2].url).toContain("/checks/check-ev-1");
  });

  it("fetches the brief as Markdown text", async () => {
    const seen: string[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      seen.push(url);
      void init;
      return new Response("# Booth brief — booth1\n", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    };
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "booth1",
      credential: "booth-cred",
      fetchFn,
    });
    const md = await booth.getBriefMarkdown();
    expect(md).toContain("# Booth brief — booth1");
    expect(seen[0]).toContain("format=md");
  });
});

describe("ActClient webhooks", () => {
  it("creates a webhook with snake_case fields and returns the one-time secret", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.url.endsWith("/api/v1/webhooks") && call.method === "POST") {
        return {
          status: 201,
          json: {
            webhook: {
              id: "w1",
              url: "https://receiver.example/hook",
              scope: "booth",
              booth_id: "booth1",
              event_types: ["finding"],
              status: "active",
              last_delivery_at: null,
              created_at: "2026-11-24T00:00:00.000Z",
              updated_at: "2026-11-24T00:00:00.000Z",
              paused_at: null,
            },
            secret: "mbw_test_secret",
          },
        };
      }
      return { status: 200, json: { webhooks: [] } };
    });
    const client = new ActClient({ baseUrl: "https://act.example", token: "act_t", fetchFn });
    const created = await client.createWebhook({
      url: "https://receiver.example/hook",
      eventTypes: ["finding"],
      boothId: "booth1",
      participantCredential: "cred-1",
    });
    expect(created.secret).toBe("mbw_test_secret");
    expect(created.webhook.scope).toBe("booth");
    expect(JSON.parse(calls[0].body)).toEqual({
      url: "https://receiver.example/hook",
      event_types: ["finding"],
      booth_id: "booth1",
      participant_credential: "cred-1",
    });
    await client.listWebhooks();
    expect(calls[1].url).toBe("https://act.example/api/v1/webhooks");
    await client.testWebhook("w1");
    const testCall = calls.find((c) => c.url.endsWith("/api/v1/webhooks/w1/test"));
    expect(testCall?.method).toBe("POST");
    await client.listWebhookDeliveries("w1", 5);
    const last = calls[calls.length - 1];
    expect(last.url).toBe("https://act.example/api/v1/webhooks/w1/deliveries?limit=5");
    expect(last.method).toBe("GET");
  });
});

describe("BoothClient streaming (Phase 13)", () => {
  it("streams open, event, and end frames, resuming with the Last-Event-ID header", async () => {
    const sse =
      ": moonbooth stream open\n\n" +
      'event: stream_open\ndata: {"booth":"b1","since":4,"mode":"relevant","latest_seq":9}\n\n' +
      ": heartbeat\n\n" +
      'id: 5\nevent: booth_event\ndata: {"id":"e5","seq":5,"type":"finding","subject":"pricing","payload":{},"author":{},"in_reply_to":null,"related_ids":null,"created_at":"2026-11-24T00:00:00.000Z","reasons":["authored"]}\n\n' +
      'id: 6\nevent: booth_event\ndata: {"id":"e6","seq":6,"type":"note","subject":"pricing","payload":{},"author":{},"in_reply_to":null,"related_ids":null,"created_at":"2026-11-24T00:00:01.000Z","reasons":["subscribed_subject"]}\n\n' +
      'event: stream_end\ndata: {"reason":"lifetime","next_since":6,"latest_seq":9}\n\n';
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "b1",
      credential: "cred-1",
      fetchFn: fetchFn as never,
    });
    const frames = [];
    for await (const frame of booth.streamChanges({ since: 4 })) frames.push(frame);
    expect(seen[0].url).toBe("https://act.example/api/v1/booths/b1/stream");
    expect(seen[0].headers["last-event-id"]).toBe("4");
    expect(seen[0].headers.accept).toBe("text/event-stream");
    expect(frames.map((f) => f.type)).toEqual(["open", "event", "event", "end"]);
    const events = frames.filter((f) => f.type === "event");
    expect(events.map((f) => (f.type === "event" ? f.seq : 0))).toEqual([5, 6]);
    const end = frames[frames.length - 1];
    expect(end.type === "end" && end.next_since).toBe(6);
  });

  it("surfaces a refused stream as an ActApiError with the server's code", async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({ error: { code: "admission_failed", message: "Admission failed." } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    const booth = new BoothClient({
      baseUrl: "https://act.example",
      boothId: "locked1",
      fetchFn: fetchFn as never,
    });
    await expect(async () => {
      for await (const frame of booth.streamChanges()) void frame;
    }).rejects.toMatchObject({ status: 401, code: "admission_failed" });
  });
});

describe("ActClient publication policy (Phase 10)", () => {
  it("reads, replaces, and clears the policy at the publication endpoint", async () => {
    const { calls, fetchFn } = mockFetch((call) => {
      if (call.method === "PUT") {
        const body = JSON.parse(call.body) as { subjects: string[]; event_types: string[] | null };
        return {
          status: 200,
          json: { booth_id: "b1", publication: { subjects: body.subjects, event_types: body.event_types } },
        };
      }
      return { status: 200, json: { booth_id: "b1", publication: null } };
    });
    const client = new ActClient({ baseUrl: "https://act.example", token: "tok", fetchFn });
    const read = await client.getPublicationPolicy("b1");
    expect(read.publication).toBeNull();
    expect(calls[0].url).toBe("https://act.example/api/v1/account/booths/b1/publication");
    const set = await client.setPublicationPolicy("b1", {
      subjects: ["pricing"],
      eventTypes: ["finding"],
    });
    expect(set.publication).toEqual({ subjects: ["pricing"], event_types: ["finding"] });
    expect(JSON.parse(calls[1].body)).toEqual({ subjects: ["pricing"], event_types: ["finding"] });
    const cleared = await client.clearPublicationPolicy("b1");
    expect(cleared.publication).toBeNull();
    expect(calls[2].method).toBe("DELETE");
  });
});
