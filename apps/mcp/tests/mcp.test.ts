import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActClient } from "@moonbooth/sdk";
import { createActMcpServer } from "../src/server.js";

// Stub ACT API: records the Authorization header, serves one transfer,
// and refuses package reads for transfers the caller is not part of.
let api: Server;
let baseUrl: string;
const seenAuth: string[] = [];
const seenBoothQueries: string[] = [];
let lastPublishBody = "";
let lastCrossBody = "";
let lastWhatifBody = "";
let lastCapsuleBody = "";

beforeAll(async () => {
  api = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
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
                details: {
                  transferId: "t-draft",
                  digest: "sha256:stubdigest",
                  summary: { capabilityName: "Stub Capability", files: [{ path: "SKILL.md", sizeBytes: 42 }] },
                },
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
    } else if (req.url === "/api/v1/booths/b1/unlock" && req.method === "POST") {
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
    } else if (req.url === "/api/v1/booths/b1/invitations" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { scopes?: string[] };
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            invitation: {
              id: "inv1",
              booth_id: "b1",
              scopes: parsed.scopes ?? [],
              state: "active",
              token: "mbi_stubtoken",
            },
          }),
        );
      });
    } else if (req.url?.startsWith("/api/v1/booths/b1/changes") && req.method === "GET") {
      seenBoothQueries.push(req.url);
      res.end(
        JSON.stringify({
          events: [],
          latest_seq: 4,
          acked_seq: 0,
          next_since: 0,
          subscription: { id: "s1", delivered_cursor: 0, acked_cursor: 0 },
          wake: { poll_after_seconds: 5, long_poll_max_seconds: 25 },
        }),
      );
    } else if (req.url === "/api/v1/booths/b1/checks/check-ev-1" && req.method === "GET") {
      res.end(
        JSON.stringify({
          check_event_id: "check-ev-1",
          seq: 3,
          subject: "check:release",
          title: "Release is verified",
          target: { kind: "booth", commitment_event_id: null, subject: null },
          status: "passed",
          status_reason: null,
          assertions: [],
          author_participant_id: "p1",
          created_at: "2026-11-24T00:00:00.000Z",
          evaluated_seq: 5,
        }),
      );
    } else if (req.url === "/api/v1/booths/b1/checks" && req.method === "GET") {
      res.end(
        JSON.stringify({
          checks: [{ check_event_id: "check-ev-1", status: "passed" }],
          latest_seq: 5,
          participant_id: "p1",
        }),
      );
    } else if (req.url === "/api/v1/booths/b1/watchers" && req.method === "POST") {
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
    } else if (req.url === "/api/v1/booths/b1/watchers" && req.method === "GET") {
      res.end(
        JSON.stringify({
          watchers: [{ id: "w1", kind: "contract_changed", subject: "contract:api" }],
          subscription_id: "s1",
          participant_id: "p1",
        }),
      );
    } else if (req.url === "/api/v1/booths/b1/watchers/w1" && req.method === "DELETE") {
      res.end(JSON.stringify({ revoked: "w1", watchers: [], subscription: { id: "s1" } }));
    } else if (req.url === "/api/v1/booths/b1/publish" && req.method === "POST") {
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
                events: [{ event_id: "e1", seq: 1, type: "decision", subject: "s", digest: "d".repeat(64) }],
                receipt: { receipt_id: "rcpt_1", receipt_digest: "e".repeat(64) },
              },
            },
            parent: { id: "parent1", url: "https://x/b/parent1" },
            child: { id: "b1" },
            replayed: false,
          }),
        );
      });
    } else if (req.url === "/api/v1/booths/b1/cross-subscriptions" && req.method === "POST") {
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
              subjects: [],
              event_types: null,
              state: "active",
              created_at: "2026-11-24T00:00:00.000Z",
            },
            created: true,
          }),
        );
      });
    } else if (req.url === "/api/v1/booths/b1/cross-subscriptions" && req.method === "GET") {
      res.end(JSON.stringify({ subscriptions: [{ id: "xsub1", source_booth_id: "src1" }] }));
    } else if (req.url === "/api/v1/booths/b1/cross-subscriptions/xsub1" && req.method === "DELETE") {
      res.end(
        JSON.stringify({
          revoked: "xsub1",
          subscription: { id: "xsub1", source_booth_id: "src1", state: "revoked" },
        }),
      );
    } else if (req.url === "/api/v1/booths/b1/whatif" && req.method === "POST") {
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
    } else if (req.url === "/api/v1/booths/b1/capsules/preview" && req.method === "POST") {
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
    } else if (req.url === "/api/v1/booths/b1/capsules/cap1/import" && req.method === "POST") {
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
    } else if (req.url === "/api/v1/booths/b1/capsules/cap1/skill-export" && req.method === "POST") {
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
    } else if (req.url === "/api/v1/booths/b1/events" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { type?: string };
        res.statusCode = 201;
        res.end(JSON.stringify({ event: { id: "check-ev-1", type: parsed.type ?? "check" }, replayed: false }));
      });
    } else if (req.url === "/api/v1/webhooks" && req.method === "POST") {
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          webhook: {
            id: "w1",
            url: "https://receiver.example/hook",
            scope: "account",
            booth_id: null,
            event_types: null,
            status: "active",
            last_delivery_at: null,
            created_at: "2026-11-24T00:00:00.000Z",
            updated_at: "2026-11-24T00:00:00.000Z",
            paused_at: null,
          },
          secret: "mbw_mcp_secret",
        }),
      );
    } else if (req.url === "/api/v1/transfers/t1" && req.method === "GET") {
      res.end(JSON.stringify({ transfer: { id: "t1", state: "DRAFT", digest: "abc" } }));
    } else if (req.url === "/api/v1/transfers/other/package") {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          error: { code: "forbidden", message: "You are not part of this transfer." },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
    }
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(() => api.close());

async function connect() {
  const client = new ActClient({ baseUrl, token: "act_test_token" });
  const server = createActMcpServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "act-test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

describe("ACT MCP server", () => {
  it("completes the initialize handshake and lists the ACT tools", async () => {
    const mcpClient = await connect();
    const tools = await mcpClient.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "act_alias_claim",
      "act_alias_release",
      "act_alias_rename",
      "act_alias_resolve",
      "act_booth_accept_commitment",
      "act_booth_ask",
      "act_booth_brief",
      "act_booth_cancel_commitment",
      "act_booth_capsule_preview",
      "act_booth_changes",
      "act_booth_check_result",
      "act_booth_create_capsule",
      "act_booth_create_cross_subscription",
      "act_booth_create_invitation",
      "act_booth_create_watcher",
      "act_booth_declare_check",
      "act_booth_export_capsule_skill",
      "act_booth_get_capsule",
      "act_booth_import_capsule",
      "act_booth_list_access_requests",
      "act_booth_list_checks",
      "act_booth_list_commitments",
      "act_booth_list_cross_subscriptions",
      "act_booth_list_invitations",
      "act_booth_list_participants",
      "act_booth_list_watchers",
      "act_booth_propose_commitment",
      "act_booth_protect",
      "act_booth_publish_result",
      "act_booth_replay",
      "act_booth_request_access",
      "act_booth_revoke_cross_subscription",
      "act_booth_revoke_invitation",
      "act_booth_revoke_invitation_grants",
      "act_booth_revoke_participant",
      "act_booth_revoke_watcher",
      "act_booth_rotate_secret",
      "act_booth_unlock",
      "act_booth_whatif",
      "act_create_draft",
      "act_create_share_link",
      "act_get_receipt",
      "act_get_transfer",
      "act_inspect_package",
      "act_namespace_claim",
      "act_namespace_get",
      "act_namespace_rename",
      "act_offer_approve",
      "act_offer_transfer",
      "act_persistent_booth_archive",
      "act_persistent_booth_close",
      "act_persistent_booth_configure",
      "act_persistent_booth_create",
      "act_persistent_booth_delete",
      "act_persistent_booth_export",
      "act_persistent_booth_get",
      "act_persistent_booth_list",
      "act_persistent_booth_restore",
      "act_persistent_booth_revoke_participant",
      "act_persistent_booth_rotate_credentials",
      "act_run_verification",
      "act_webhook_create",
      "act_webhook_delete",
      "act_webhook_deliveries",
      "act_webhook_list",
      "act_webhook_test",
    ]);
    const approve = tools.tools.find((t) => t.name === "act_offer_approve");
    const props = (approve?.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(Object.keys(props ?? {})).toContain("digest");
    await mcpClient.close();
  });

  it("act_get_transfer calls the API with the bearer token", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({ name: "act_get_transfer", arguments: { transferId: "t1" } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"state": "DRAFT"');
    expect(seenAuth).toContain("Bearer act_test_token");
    await mcpClient.close();
  });

  it("act_booth_publish_result forwards the publication to the booth API (Phase 8)", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_booth_publish_result",
      arguments: {
        boothId: "b1",
        credential: "child-cred",
        parentCredential: "parent-cred",
        eventIds: ["e1"],
        receiptId: "rcpt_1",
      },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"evt_pub"');
    expect(text).toContain('"parent1"');
    expect(seenAuth).toContain("Bearer child-cred");
    expect(JSON.parse(lastPublishBody)).toEqual({
      parent_credential: "parent-cred",
      event_ids: ["e1"],
      receipt_id: "rcpt_1",
    });
    await mcpClient.close();
  });

  it("act_booth_whatif forwards the hypothetical events and prints the delta (Phase 11)", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_booth_whatif",
      arguments: {
        boothId: "b1",
        credential: "booth-cred",
        events: [{ type: "contract", subject: "contract:api", payload: { version: "v2" } }],
        atSeq: 4,
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"contract_conflict"');
    expect(text).toContain('"hypothetical": true');
    expect(seenAuth[seenAuth.length - 1]).toBe("Bearer booth-cred");
    expect(JSON.parse(lastWhatifBody)).toEqual({
      events: [{ type: "contract", subject: "contract:api", payload: { version: "v2" } }],
      at_seq: 4,
    });
    await mcpClient.close();
  });

  it("act_booth capsule tools preview, import, and export skills (Phase 12)", async () => {
    const mcpClient = await connect();
    const preview = await mcpClient.callTool({
      name: "act_booth_capsule_preview",
      arguments: {
        boothId: "b1",
        credential: "booth-cred",
        selection: { sections: ["contracts"] },
      },
    });
    expect(preview.isError).toBeFalsy();
    const previewText = (preview.content as Array<{ text: string }>)[0].text;
    expect(previewText).toContain('"summary_markdown"');
    expect(JSON.parse(lastCapsuleBody)).toEqual({ selection: { sections: ["contracts"] } });

    const imported = await mcpClient.callTool({
      name: "act_booth_import_capsule",
      arguments: { boothId: "b1", credential: "booth-cred", capsuleId: "cap1" },
    });
    expect(imported.isError).toBeFalsy();
    const importText = (imported.content as Array<{ text: string }>)[0].text;
    expect(importText).toContain('"decision_accept"');
    expect(importText).toContain('"origin_booth_id": "b0"');

    const exported = await mcpClient.callTool({
      name: "act_booth_export_capsule_skill",
      arguments: { boothId: "b1", credential: "booth-cred", capsuleId: "cap1", versionId: "v1" },
    });
    expect(exported.isError).toBeFalsy();
    const exportText = (exported.content as Array<{ text: string }>)[0].text;
    expect(exportText).toContain('"verification_receipt_ids"');
    expect(JSON.parse(lastCapsuleBody)).toEqual({ version_id: "v1" });
    await mcpClient.close();
  });

  it("act_booth_create_cross_subscription forwards both credentials to the booth API (Phase 10)", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_booth_create_cross_subscription",
      arguments: {
        boothId: "b1",
        credential: "dest-cred",
        sourceBoothId: "src1",
        sourceCredential: "src-cred",
        subjects: ["api-contract"],
      },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"xsub1"');
    expect(JSON.parse(lastCrossBody)).toEqual({
      source_booth_id: "src1",
      source_credential: "src-cred",
      subjects: ["api-contract"],
    });

    const list = await mcpClient.callTool({
      name: "act_booth_list_cross_subscriptions",
      arguments: { boothId: "b1", credential: "dest-cred" },
    });
    expect((list.content as Array<{ text: string }>)[0].text).toContain('"xsub1"');

    const revoke = await mcpClient.callTool({
      name: "act_booth_revoke_cross_subscription",
      arguments: { boothId: "b1", credential: "dest-cred", subscriptionId: "xsub1" },
    });
    expect((revoke.content as Array<{ text: string }>)[0].text).toContain('"revoked"');
    await mcpClient.close();
  });

  it("act_create_share_link returns the URL for an approved transfer", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_create_share_link",
      arguments: { transferId: "t-offered" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("http://localhost:3000/l/stubtoken");
    await mcpClient.close();
  });

  it("act_create_share_link returns needs_approval with the digest instead of a link", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_create_share_link",
      arguments: { transferId: "t-draft" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as { status: string; digest: string; summary: { capabilityName: string } };
    expect(parsed.status).toBe("needs_approval");
    expect(parsed.digest).toBe("sha256:stubdigest");
    expect(parsed.summary.capabilityName).toBe("Stub Capability");
    expect(text).not.toContain("/l/");
    await mcpClient.close();
  });

  it("act_booth_changes forwards the cursor and the bounded wait, with the booth credential", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_booth_changes",
      arguments: { boothId: "b1", credential: "booth-cred", since: 2, waitSeconds: 10 },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"latest_seq": 4');
    const query = seenBoothQueries[seenBoothQueries.length - 1] ?? "";
    expect(query).toContain("since=2");
    expect(query).toContain("wait_seconds=10");
    // The booth credential, not the account token, went on the wire.
    expect(seenAuth[seenAuth.length - 1]?.startsWith("Bearer ")).toBe(true);
    expect(seenAuth[seenAuth.length - 1]?.endsWith("booth-cred")).toBe(true);
    await mcpClient.close();
  });

  it("act_booth_unlock exchanges the admission secret for a credential", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_booth_unlock",
      arguments: { boothId: "b1", secret: "mbk_test", role: "recipient" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("unlocked-cred");
    expect(text).toContain("generated_key");
    const refused = await mcpClient.callTool({
      name: "act_booth_unlock",
      arguments: { boothId: "b1", secret: "mbk_wrong" },
    });
    expect(refused.isError).toBe(true);
    const refusedText = (refused.content as Array<{ text: string }>)[0].text;
    expect(refusedText).toContain("admission_failed");
    await mcpClient.close();
  });

  it("act_booth_create_invitation issues an invitation with the creator credential", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_booth_create_invitation",
      arguments: { boothId: "b1", credential: "creator-cred", scopes: ["booth.read", "events.read"] },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("mbi_stubtoken");
    expect(text).toContain('"events.read"');
    // The creator credential, not the account token, went on the wire.
    expect(seenAuth[seenAuth.length - 1]?.endsWith("creator-cred")).toBe(true);
    await mcpClient.close();
  });

  it("surfaces the API refusal for a transfer the owner is not part of", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_inspect_package",
      arguments: { transferId: "other" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("forbidden");
    await mcpClient.close();
  });

  it("act_booth_declare_check declares and act_booth_check_result reads the result (Phase 5)", async () => {
    const mcpClient = await connect();
    const declared = await mcpClient.callTool({
      name: "act_booth_declare_check",
      arguments: {
        boothId: "b1",
        credential: "booth-cred",
        title: "Release is verified",
        assertions: [{ kind: "evidence_present", evidence_kind: "completion", subject: "work:release" }],
      },
    });
    expect(declared.isError).toBeFalsy();
    const declaredText = (declared.content as Array<{ text: string }>)[0].text;
    expect(declaredText).toContain("check-ev-1");

    const listed = await mcpClient.callTool({
      name: "act_booth_list_checks",
      arguments: { boothId: "b1", credential: "booth-cred" },
    });
    expect(listed.isError).toBeFalsy();
    expect((listed.content as Array<{ text: string }>)[0].text).toContain('"passed"');

    const result = await mcpClient.callTool({
      name: "act_booth_check_result",
      arguments: { boothId: "b1", credential: "booth-cred", checkEventId: "check-ev-1" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("evaluated_seq");
    await mcpClient.close();
  });

  it("act_booth_create_watcher declares, list_watchers lists, and revoke_watcher revokes (Phase 6)", async () => {
    const mcpClient = await connect();
    const created = await mcpClient.callTool({
      name: "act_booth_create_watcher",
      arguments: { boothId: "b1", credential: "booth-cred", kind: "contract_changed", subject: "contract:api" },
    });
    expect(created.isError).toBeFalsy();
    const createdText = (created.content as Array<{ text: string }>)[0].text;
    expect(createdText).toContain('"id": "w1"');
    expect(createdText).toContain("contract_changed");

    const listed = await mcpClient.callTool({
      name: "act_booth_list_watchers",
      arguments: { boothId: "b1", credential: "booth-cred" },
    });
    expect(listed.isError).toBeFalsy();
    expect((listed.content as Array<{ text: string }>)[0].text).toContain("contract:api");

    const revoked = await mcpClient.callTool({
      name: "act_booth_revoke_watcher",
      arguments: { boothId: "b1", credential: "booth-cred", watcherId: "w1" },
    });
    expect(revoked.isError).toBeFalsy();
    expect((revoked.content as Array<{ text: string }>)[0].text).toContain("revoked");
    await mcpClient.close();
  });

  it("act_webhook_create returns the webhook and its one-time secret", async () => {
    const mcpClient = await connect();
    const result = await mcpClient.callTool({
      name: "act_webhook_create",
      arguments: { url: "https://receiver.example/hook" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("mbw_mcp_secret");
    expect(text).toContain('"id": "w1"');
    await mcpClient.close();
  });
});
