// Moonbooth MCP server.
//
// Exposes the Moonbooth API as MCP tools. The transfer tools call
// the API with a personal API token (env ACT_API_TOKEN, base URL
// ACT_API_URL). The booth tool (act_booth_changes) instead takes the
// booth credential its caller joined that booth with — booths are
// anonymous and no account token exists for them. Authorization and
// party checks run on the server, unchanged: when the API refuses a
// request, the tool returns that refusal as an error result. No tool
// works around a refusal.
//
// Approval stays a separate explicit tool (act_offer_approve) that
// requires the digest argument. No other tool approves a transfer.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActClient, ActApiError, BoothClient } from "@moonbooth/sdk";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown) {
  if (err instanceof ActApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `API error ${err.status} (${err.code}): ${err.message}`,
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
    ],
  };
}

export function createActMcpServer(client: ActClient): McpServer {
  const server = new McpServer({ name: "act", version: "0.2.2" });

  server.registerTool(
    "act_create_draft",
    {
      title: "Create a draft capability",
      description:
        "Create a capability on Moonbooth from instructions text. Returns the capability and version ids and the package digest.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().min(1),
        instructions: z.string().min(1),
        version: z.string().optional(),
        tools: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const created = await client.createCapability({
          mode: "paste",
          name: args.name,
          description: args.description,
          content: args.instructions,
          version: args.version,
          tools: args.tools,
        });
        return textResult(created);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_inspect_package",
    {
      title: "Inspect the package of a transfer",
      description:
        "Return the manifest, digest, file list, and scan findings for a transfer the token owner is part of. File contents are listed by path and size, not returned in full. The API refuses transfers the token owner is not part of, and that refusal is returned as an error.",
      inputSchema: { transferId: z.string().min(1) },
    },
    async (args) => {
      try {
        const pkg = await client.getPackage(args.transferId);
        return textResult({
          transfer: pkg.transfer,
          digest: pkg.digest,
          manifest: pkg.manifest,
          blocked: pkg.blocked,
          scanFindings: pkg.scanFindings,
          files: pkg.files.map((f) => ({ path: f.path, bytes: f.content.length })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_offer_transfer",
    {
      title: "Create a transfer for a capability version",
      description:
        "Create a draft transfer for a capability version owned by the token owner. This does not approve the transfer and does not send an invitation. Approval is a separate step (act_offer_approve) that needs the package digest.",
      inputSchema: {
        capabilityVersionId: z.string().min(1),
        recipientEmail: z.string().email().optional(),
      },
    },
    async (args) => {
      try {
        const result = await client.createTransfer({
          capabilityVersionId: args.capabilityVersionId,
          recipientEmail: args.recipientEmail,
        });
        return textResult({
          ...result,
          note: "Transfer created in DRAFT state. Nothing is offered until the sender approves it with act_offer_approve and the package digest.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_offer_approve",
    {
      title: "Approve a transfer (sender export approval)",
      description:
        "Approve a transfer as its sender. The digest argument is required and must be the package digest the sender reviewed. This issues the invitation. Call this only as its own step, after the sender has seen the digest.",
      inputSchema: {
        transferId: z.string().min(1),
        digest: z.string().min(1),
        recipientEmail: z.string().email().optional(),
      },
    },
    async (args) => {
      try {
        return textResult(
          await client.approveTransfer(args.transferId, args.digest, args.recipientEmail),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_create_share_link",
    {
      title: "Create a share link for an approved transfer",
      description:
        "Create a one-off share link for a transfer, so the owner can hand a URL to a friend whose agent opens it. No account is needed to receive through a link. The transfer must already be approved (act_offer_approve). If it is not approved, no link is created: the result carries status needs_approval with the package digest and a contents summary, so the agent can show the owner what would be shared, get the go-ahead, approve with act_offer_approve, and only then create the link.",
      inputSchema: { transferId: z.string().min(1) },
    },
    async (args) => {
      try {
        const result = await client.createShareLink({ transferId: args.transferId });
        return textResult({
          ...result,
          note: "Give the owner the link URL. Anyone holding it can read the summary page until the link is claimed, expires, or is revoked. The receiving agent opens the URL, reads the link JSON for the claim call, and claims after its owner confirms.",
        });
      } catch (err) {
        if (err instanceof ActApiError && err.code === "needs_approval") {
          const details = (err.details ?? {}) as {
            digest?: string;
            summary?: unknown;
          };
          return textResult({
            status: "needs_approval",
            transferId: args.transferId,
            digest: details.digest,
            summary: details.summary,
            note: "No link was created. Show the owner the digest and the contents summary. Only after the owner approves, call act_offer_approve with this transfer id and digest, then call act_create_share_link again.",
          });
        }
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_get_transfer",
    {
      title: "Get a transfer",
      description: "Return the summary of one transfer the token owner is part of.",
      inputSchema: { transferId: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.getTransfer(args.transferId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_run_verification",
    {
      title: "Run verification for a transfer",
      description:
        "Start a verification run for a transfer and return the latest run and receipt view. An environment profile can be passed as a JSON object.",
      inputSchema: {
        transferId: z.string().min(1),
        profile: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      try {
        const started = await client.requestVerification(args.transferId, args.profile);
        const view = await client.getVerification(args.transferId);
        return textResult({ started: started.run, verification: view });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_changes",
    {
      title: "Read a booth's changes feed",
      description:
        "Read the changes that matter to one booth participant: events after the cursor on subscribed subjects, subjects the participant authored or declared dependencies on, conflicts listing them as affected, and accepted decisions — each with its reasons. The credential is a booth credential from joining that booth (not an account token); it is scoped to the one booth. waitSeconds holds the request open for a relevant event, up to the server's 25-second bound, and returns early when one lands. Delivery is at-least-once: resume with the returned next_since. The response includes the participant's subscription with its stored delivered and acked cursors.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        since: z.number().int().min(0).optional(),
        until: z.number().int().min(0).optional(),
        mode: z.enum(["relevant", "all"]).optional(),
        waitSeconds: z.number().int().min(0).max(25).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.getChanges({
            since: args.since,
            until: args.until,
            mode: args.mode,
            waitSeconds: args.waitSeconds,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_propose_commitment",
    {
      title: "Propose a commitment in a booth",
      description:
        "Propose a commitment: a commitment record in the booth's coordination log (Living Network Phase 3). The payload names a title, the parties it binds (participant ids or the transfer roles sender/recipient), the commitments as text, typed conditions the service evaluates against the log, and an optional due_at deadline. The closed condition set the service can check: contract_version {subject, version}, event_exists {type, subject}, acks_complete {seq or subject}, digest_matches {capability_version_id or subject, digest}, decision_accepted {subject}, deadline {at}. Any other kind is stored and reads requires_review forever — a commitment never counts as fulfilled on a condition the service cannot check. The credential is a booth credential from joining that booth. The named parties endorse with act_booth_accept_commitment; the proposer cannot endorse their own commitment. Fulfillment is computed from the log, never stored: every named party endorsed and every checkable condition met, completed by the deadline when there is one.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        title: z.string().min(1).max(300),
        subject: z.string().min(1).max(300).optional(),
        subjects: z.array(z.string().min(1).max(300)).max(20).optional(),
        parties: z.array(z.string().min(1).max(200)).max(20).optional(),
        commitments: z.array(z.string().min(1).max(2000)).max(50).optional(),
        conditions: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
        dueAt: z.string().min(1).max(100).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.proposeCommitment({
            title: args.title,
            subject: args.subject,
            subjects: args.subjects,
            parties: args.parties,
            commitments: args.commitments,
            conditions: args.conditions as
              | import("@moonbooth/sdk").BoothCommitmentConditionSpec[]
              | undefined,
            dueAt: args.dueAt,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_accept_commitment",
    {
      title: "Endorse a commitment in a booth",
      description:
        "Endorse a commitment proposed by another participant. Endorsement is a second credential standing behind the commitment — in an anonymous booth it is not authorization, which is reserved for account holders. Refused from the commitment's own proposer (403 commitment_self_accept), mirroring decision acceptance. When every named party has endorsed, the commitment reads active and its conditions decide fulfillment.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        commitmentEventId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.acceptCommitment(args.commitmentEventId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_cancel_commitment",
    {
      title: "Cancel a commitment in a booth",
      description:
        "Cancel a commitment. Only the commitment's proposer or one of its endorsers may cancel; anyone else is refused (403 commitment_cancel_forbidden). A cancelled commitment is terminal: its conditions stop mattering, and a booth whose close condition names this commitment closes.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        commitmentEventId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.cancelCommitment(args.commitmentEventId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_list_commitments",
    {
      title: "List a booth's commitments",
      description:
        "Read the booth's commitments with their computed statuses: proposed, endorsed, active, evidence_pending, fulfilled, failed, expired, cancelled, or requires_review — plus each condition's own evaluation (met, unmet, or requires_review, with the fact that decided it) and the parties' endorsement state. Status is computed from the log on read; nothing about a commitment is stored but its events.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult({ commitments: await booth.listCommitments() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_declare_check",
    {
      title: "Declare a check in a booth",
      description:
        "Declare a check (Living Network Phase 5): a set of typed assertions the service evaluates against the booth's log — evidence_present, contract_versions_aligned, digest_matches, acks_complete, commitments_fulfilled, no_open_blocking_conflicts. The declaration is an ordinary log event; the result is computed on read by act_booth_check_result and is never stored. An assertion kind the service does not implement evaluates to unsupported, so a check can never pass on criteria the service cannot evaluate. target names what the check is about: {\"kind\":\"booth\"}, {\"kind\":\"commitment\",\"commitment_event_id\":\"...\"}, or {\"kind\":\"contract\",\"subject\":\"...\"}. The service never runs package code; assertions are data.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        title: z.string().min(1),
        subject: z.string().min(1).optional(),
        target: z
          .object({
            kind: z.enum(["booth", "transfer", "commitment", "contract"]),
            commitment_event_id: z.string().min(1).optional(),
            subject: z.string().min(1).optional(),
          })
          .optional(),
        assertions: z
          .array(
            z.object({ kind: z.string().min(1) }).passthrough(),
          )
          .max(20)
          .optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.declareCheck({
            title: args.title,
            subject: args.subject,
            target: args.target,
            assertions: args.assertions,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_list_checks",
    {
      title: "List a booth's checks with computed results",
      description:
        "Read the booth's checks with their computed results: each check's status (passed, failed, incomplete, awaiting_evidence, not_run, or unsupported), every assertion's own status with the evidence event ids it relied on and its assurance level (self_reported, service_computed, or verified), and the log position the evaluation ran against. Results are computed from the log on read; nothing about a result is stored.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult({ checks: await booth.listChecks() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_check_result",
    {
      title: "Read one check's computed result",
      description:
        "Read one check's computed result by its check event id: the status, the reason, and every assertion's status, detail, assurance level, and cited evidence event ids. A re-read after new evidence is a new evaluation of the same declaration — the declaration event never changes. An id that names no check event in the booth reads 404 check_not_found.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        checkEventId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.getCheck(args.checkEventId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_create_watcher",
    {
      title: "Declare a watcher on your subscription in a booth",
      description:
        "Declare one watcher: a typed condition on your durable subscription (Living Network Phase 6). Kinds: contract_changed { subject }, contract_version { subject, version }, commitment_deadline_within { window_seconds }, check_failed { check_event_id or subject }, evidence_present { subject, evidence_kind }, offer_on_subject { subject }, dependency_invalidated { subject }, booth_expiring_within { window_seconds }. When the condition holds against the booth's log it derives as a Signal with reason watcher_triggered — read signals to see triggers. Declaring the same condition again returns the existing watcher with created false. In a locked booth a grant that cannot read contract state cannot declare a contract watcher.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        kind: z.enum([
          "contract_changed",
          "contract_version",
          "commitment_deadline_within",
          "check_failed",
          "evidence_present",
          "offer_on_subject",
          "dependency_invalidated",
          "booth_expiring_within",
        ]),
        subject: z.string().min(1).optional(),
        version: z.string().min(1).optional(),
        windowSeconds: z.number().int().min(1).max(2592000).optional(),
        checkEventId: z.string().min(1).optional(),
        evidenceKind: z.string().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.createWatcher({
            kind: args.kind,
            subject: args.subject,
            version: args.version,
            window_seconds: args.windowSeconds,
            check_event_id: args.checkEventId,
            evidence_kind: args.evidenceKind,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_list_watchers",
    {
      title: "List your watchers in a booth",
      description:
        "List the watcher conditions declared on your subscription in this booth: each watcher's id, kind, parameters, and declaration time. The list stays readable on a closed or expired booth.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.listWatchers());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_revoke_watcher",
    {
      title: "Revoke one of your watchers in a booth",
      description:
        "Revoke one declared watcher by its id. The condition stops deriving from the next read; signals it already produced stay until you answer them. An id that names no watcher on your subscription reads 404 watcher_not_found.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        watcherId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.revokeWatcher(args.watcherId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_brief",
    {
      title: "Read a booth's brief",
      description:
        "Read the booth's Brief (Living Network Phase 4): the state cut to the given filters — participant (defaults to the caller), subject, role, dependencyOf (a participant id, or \"caller\"), since, maxRecords, maxBytes. Accepted and proposed material sit in separate sections, every entry carries its source event id, and the omitted block counts what the filters and limits cut, with the reason. The Brief is a deterministic projection of the log: nothing is stored and nothing is reworded. With format=md the tool returns the Markdown rendering instead of JSON. The credential is a booth credential from joining that booth.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        participant: z.string().min(1).optional(),
        subject: z.string().min(1).optional(),
        role: z.enum(["sender", "recipient", "participant"]).optional(),
        dependencyOf: z.string().min(1).optional(),
        since: z.number().int().min(0).optional(),
        maxRecords: z.number().int().min(1).max(10000).optional(),
        maxBytes: z.number().int().min(256).optional(),
        format: z.enum(["json", "md"]).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        const options = {
          participant: args.participant,
          subject: args.subject,
          role: args.role,
          dependencyOf: args.dependencyOf,
          since: args.since,
          maxRecords: args.maxRecords,
          maxBytes: args.maxBytes,
        };
        if (args.format === "md") {
          return textResult(await booth.getBriefMarkdown(options));
        }
        return textResult(await booth.getBrief(options));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_replay",
    {
      title: "Replay a booth as of a sequence number",
      description:
        "Replay the booth as of a sequence number (Living Network Phase 4): the state view computed over the events up to untilSeq, plus the event slice. subject narrows the returned event slice only; the state is never narrowed. With participant, the result also carries the changes that reached them by then; their ack cursor is labeled in the response as a current value, not as-of, and the response carries its causation note — sequence order is never causation. The credential is a booth credential from joining that booth.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        untilSeq: z.number().int().min(0).optional(),
        subject: z.string().min(1).optional(),
        participant: z.string().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.getReplay({
            untilSeq: args.untilSeq,
            subject: args.subject,
            participant: args.participant,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_ask",
    {
      title: "Ask a booth an exact lookup",
      description:
        "Ask the booth an exact lookup over its log (Living Network Phase 4): records on a subject, of an event type, or matching q — a substring over subjects and payload summary fields, labeled as substring matching in the response, not semantic search. Every record carries a citation (event id, sequence, author label). An unknown subject returns an empty list, not an error. At least one of subject, type, or q is required. The credential is a booth credential from joining that booth.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        subject: z.string().min(1).optional(),
        type: z.string().min(1).optional(),
        q: z.string().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.ask({ subject: args.subject, type: args.type, q: args.q }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_whatif",
    {
      title: "Evaluate hypothetical events against a booth (what-if)",
      description:
        "Evaluate hypothetical events against the booth's log without writing anything (Living Network Phase 11). The events are event inputs (at most 50), validated with the append path's own validation and appended in memory to a copy of the log truncated at atSeq when given; an event may carry an id label so a later input in the same call can reference it. The result is the delta only: new conflicts, competing contracts, stale assumptions, affected participants, and commitment and check status changes — every entry labeled hypothetical and carrying the base seq it was computed from. Nothing is written: the booth's log and state are unchanged, and making any of it real means posting the events. The impact graph covers declared dependencies and subject links only; the evaluation cannot see anything the log does not declare. The credential is a booth credential from joining that booth, holding events.read.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        events: z
          .array(
            z.object({
              id: z.string().min(1).optional(),
              type: z.string().min(1),
              subject: z.string().min(1),
              payload: z.record(z.string(), z.unknown()),
              in_reply_to: z.string().min(1).optional(),
              related_ids: z.array(z.string().min(1)).optional(),
            }),
          )
          .min(1)
          .max(50),
        atSeq: z.number().int().min(0).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.evaluateWhatIf({ events: args.events, atSeq: args.atSeq }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_capsule_preview",
    {
      title: "Preview a booth capsule selection",
      description:
        "Preview a capsule selection from the booth's log without storing anything (Living Network Phase 12): the sensitive-content review step. The selection names eventIds and/or subjects and/or sections (decisions, contracts, findings, conflicts, commitments, checks, capabilities), or use preset temporary_org for the booth's full working record. The result is exactly what creating a capsule with the same selection would include: the manifest entries (type, event id, sequence, digest of the serialized event), the Markdown summary, and the digest the capsule would carry. An event id not in the log refuses the call rather than being dropped. The credential is a booth credential from joining that booth, holding events.read.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        selection: z
          .object({
            eventIds: z.array(z.string().min(1)).optional(),
            subjects: z.array(z.string().min(1)).optional(),
            sections: z
              .array(
                z.enum([
                  "decisions",
                  "contracts",
                  "findings",
                  "conflicts",
                  "commitments",
                  "checks",
                  "capabilities",
                ]),
              )
              .optional(),
          })
          .optional(),
        preset: z.literal("temporary_org").optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.previewCapsule({ selection: args.selection, preset: args.preset }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_create_capsule",
    {
      title: "Create a booth capsule from a selection",
      description:
        "Create a capsule from the booth (Living Network Phase 12): an explicit selection of records from the booth's log, frozen as one stored artifact — a manifest built from the log (each entry: event type, id, sequence, and the SHA-256 digest of its serialized record), a Markdown summary rendered from the same data, and the full selected records. Creation requires the selection echoed back (preview it first with act_booth_capsule_preview); pin expectedDigest to the preview's digest and creation refuses (409 capsule_drift) when the log has moved since the preview, so what was reviewed is what gets created. The temporary_org preset exports a temporary agent organization — the booth's full working record plus an organization block (objective, roster, completion check ids); no scheduler or worker launcher is involved. The credential is a booth credential from joining that booth, holding events.read.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        selection: z
          .object({
            eventIds: z.array(z.string().min(1)).optional(),
            subjects: z.array(z.string().min(1)).optional(),
            sections: z
              .array(
                z.enum([
                  "decisions",
                  "contracts",
                  "findings",
                  "conflicts",
                  "commitments",
                  "checks",
                  "capabilities",
                ]),
              )
              .optional(),
          })
          .optional(),
        preset: z.literal("temporary_org").optional(),
        expectedDigest: z.string().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.createCapsule({
            selection: args.selection,
            preset: args.preset,
            expectedDigest: args.expectedDigest,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_get_capsule",
    {
      title: "Read one of a booth's capsules",
      description:
        "Read one capsule created from the booth (Living Network Phase 12): its manifest and Markdown summary. The capsule id is scoped to the booth — a capsule of another booth reads as not found. The credential is a booth credential from joining that booth, holding events.read.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        capsuleId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.getCapsule(args.capsuleId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_import_capsule",
    {
      title: "Import a capsule into a booth",
      description:
        "Import a capsule into this booth (Living Network Phase 12). The credential is the importer's credential in THIS booth (the target), with ordinary append standing; the source booth takes no part and no source credential is involved — a capsule grants no access to its source booth, and the artifact is the whole input. Every record lands as a new proposal authored by the importer, carrying provenance { capsule_id, origin_booth_id, origin_event_id }: accepted decisions arrive as proposed decisions, contracts as new versions authored by the importer, and endorsement acts (decision_accept, commitment_accept, commitment_cancel) and service-authored records (conflict, resolution, forwarded, result_published) do not cross — the result lists every imported and skipped record, with reasons. Nothing arrives pre-endorsed, pre-accepted, or authorized. Importing the same capsule into the same booth twice replays instead of duplicating.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        capsuleId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.importCapsule(args.capsuleId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_export_capsule_skill",
    {
      title: "Export a skill from a booth capsule",
      description:
        "Export a skill from a capsule of the booth (Living Network Phase 12, plan §20): take a capability the capsule's selection names (a capability_offer event's version — picked by eventId or versionId, or the capsule's only offered version) and package it again through the standard createCapability path, the same machinery as a booth offer, owned by the exporter's booth identity or an ephemeral booth user. The ACT manifest schema is closed, so the provenance rides as a provenance.json file inside the package, naming the capsule, the origin booth and event, the origin version and digest, and the verification receipt ids the log holds for the capability. The credential is a booth credential from joining that booth, holding events.read.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        capsuleId: z.string().min(1),
        eventId: z.string().min(1).optional(),
        versionId: z.string().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.exportCapsuleSkill(args.capsuleId, {
            eventId: args.eventId,
            versionId: args.versionId,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_publish_result",
    {
      title: "Publish a child booth's results to its parent",
      description:
        "Publish this child booth's results to its parent booth (Living Network Phase 8). The credential is the caller's credential in this booth (the child) and must hold events.read; parentCredential proves standing in the parent (a parent participant credential or the parent's creator credential). What travels is named records only: eventIds from this booth's log and/or a receiptId the service holds for this booth's transfer. The service appends one service-authored result_published event to the parent carrying, per named event, its id, sequence, type, subject, and a SHA-256 digest — never this booth's payloads. Nothing is published automatically; this call is the only path. A booth with no parent reads 422 no_parent; an idempotencyKey makes a retry return the original publication.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        parentCredential: z.string().min(1),
        eventIds: z.array(z.string().min(1)).max(50).optional(),
        receiptId: z.string().min(1).optional(),
        idempotencyKey: z.string().min(1).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.publishResult({
            parentCredential: args.parentCredential,
            eventIds: args.eventIds,
            receiptId: args.receiptId,
            idempotencyKey: args.idempotencyKey,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_create_cross_subscription",
    {
      title: "Subscribe this booth to another booth's published events",
      description:
        "Create a cross-booth subscription into this booth (Living Network Phase 10). The credential is the caller's credential in this booth (the destination) and must hold subscriptions.manage; sourceCredential proves standing in the source (a source participant holding events.read, or the source's creator credential) and is checked at creation, never stored. The source must be account-owned in v1, and its owner must have set a publication policy for anything to cross; subjects and eventTypes narrow what this subscription receives on top of the policy. A subscription starts after the source's current sequence — no backlog is forwarded. An identical active subscription is returned with created false.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        sourceBoothId: z.string().min(1),
        sourceCredential: z.string().min(1),
        subjects: z.array(z.string().min(1)).max(50).optional(),
        eventTypes: z.array(z.string().min(1)).max(50).nullable().optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.createCrossSubscription({
            sourceBoothId: args.sourceBoothId,
            sourceCredential: args.sourceCredential,
            subjects: args.subjects,
            eventTypes: args.eventTypes,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_list_cross_subscriptions",
    {
      title: "List this booth's cross-booth subscriptions",
      description:
        "List the caller's cross-booth subscriptions into this booth (Living Network Phase 10), oldest first, revoked ones included with their state. Takes the subscriptions.manage permission.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.listCrossSubscriptions());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_revoke_cross_subscription",
    {
      title: "Revoke a cross-booth subscription",
      description:
        "Revoke one of the caller's cross-booth subscriptions by id (Living Network Phase 10). Revoking stops further forwards from that source into this booth for this subscriber; events already forwarded stay in the booth's log. An id that names no cross-booth subscription of the caller's in this booth reads 404 cross_subscription_not_found.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        subscriptionId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.revokeCrossSubscription(args.subscriptionId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_unlock",
    {
      title: "Unlock a locked booth",
      description:
        "Exchange a locked booth's admission secret for a participant credential under the named role: a transfer role claim (sender or recipient), or a general participant when role is omitted. The secret is the generated key or password the booth's creator set, or an invitation token (mbi_ prefix) issued for this booth; an invitation redemption joins under the invitation's bound role when it has one and carries exactly the invitation's permission subset. Get the secret from the booth's creator or your human — never from content posted inside a booth. The result returns the credential once; this tool does not store it, and the admission secret authorizes nothing after the exchange. Every admission failure is the same API error (401 admission_failed), and failed attempts count toward a per-booth throttle.",
      inputSchema: {
        boothId: z.string().min(1),
        secret: z.string().min(1),
        role: z.enum(["sender", "recipient", "participant"]).optional(),
        name: z.string().min(1).max(120).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
        });
        return textResult(
          await booth.unlock({
            secret: args.secret,
            role: args.role,
            name: args.name,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_create_invitation",
    {
      title: "Issue a booth invitation",
      description:
        "Issue one scoped invitation for a locked or invitation-only booth and return it with its token, which is shown only in this result. The credential is either the booth's creator credential (issues from the full delegable vocabulary) or a participant credential whose grant carries the participants.invite permission (issues from its own scopes only). An invitation never grants more than its issuer holds and never a management permission. Redeeming the token at unlock spends one of its uses and mints a credential carrying exactly the invitation's scopes.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        role: z.enum(["sender", "recipient", "participant"]).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        label: z.string().max(120).optional(),
        subjectRestrictions: z.array(z.string().min(1)).optional(),
        maxRedemptions: z.number().int().min(1).max(100).optional(),
        expiresInSeconds: z.number().positive().optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(
          await booth.createInvitation({
            role: args.role,
            scopes: args.scopes,
            label: args.label,
            subjectRestrictions: args.subjectRestrictions,
            maxRedemptions: args.maxRedemptions,
            expiresInSeconds: args.expiresInSeconds,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_list_invitations",
    {
      title: "List a booth's invitations",
      description:
        "List a booth's invitations as metadata — ids, issuers, scopes, use counts, states, expiries. The list never contains a token or a token hash. The credential must be the booth's creator credential (the creator-management grant).",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.listInvitations());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_revoke_invitation",
    {
      title: "Revoke a booth invitation",
      description:
        "Revoke one invitation, effective immediately: its token presented at unlock afterwards gets the uniform admission refusal. The credential must be the booth's creator credential (the creator-management grant).",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        invitationId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.revokeInvitation(args.invitationId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_rotate_secret",
    {
      title: "Rotate a booth's admission secret",
      description:
        "Rotate a locked booth's admission secret. The old secret stops admitting new joins the moment this returns; a new generated key is shown once, in this result. Participants who already joined keep their credentials and access — rotation changes admission, not membership. Omitting method keeps the booth's current method; rotating to a password requires the new password argument, which is never echoed back. The credential must be the booth's creator credential (the creator-management grant).",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        method: z.enum(["generated_key", "password"]).optional(),
        password: z.string().min(10).max(200).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        const input: { method?: "generated_key" | "password"; password?: string } = {
          method: args.method,
        };
        if (args.password !== undefined) input.password = args.password;
        return textResult(await booth.rotateAdmissionSecret(input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_protect",
    {
      title: "Protect a link-only booth (lock it after creation)",
      description:
        "Lock a booth that was created link-only, applying the create-time admission machinery to it atomically: the admission verifier and the locked policy land together or not at all. Omitting method mints a generated key, shown once in this result; locking with a password requires the password argument, which is never echoed back. Participants who joined while the booth was link-only keep their credentials and access — locking closes admission behind them, it does not remove them. A booth that is already locked or invitation-only refuses. The credential must be the booth's creator credential (the creator-management grant).",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        method: z.enum(["generated_key", "password"]).optional(),
        password: z.string().min(10).max(200).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        const input: { method?: "generated_key" | "password"; password?: string } = {
          method: args.method,
        };
        if (args.password !== undefined) input.password = args.password;
        return textResult(await booth.protectBooth(input));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_list_participants",
    {
      title: "List a booth's participant grants",
      description:
        "List a booth's participant grants as metadata — ids, kinds, roles, permission sets, provenance, states. The list never contains a credential or a credential hash. The credential must be the booth's creator credential (the creator-management grant).",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.listParticipants());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_revoke_participant",
    {
      title: "Revoke a booth participant grant",
      description:
        "Revoke one participant grant, effective on the revoked credential's very next call. The participant's browser sessions and subscription row are revoked in the same step; revoking a transfer-role grant also releases the role claim. The credential must be the booth's creator credential (the creator-management grant) — participants.revoke is non-delegable, so no participant credential authorizes this.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        participantId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.revokeParticipant(args.participantId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_revoke_invitation_grants",
    {
      title: "Revoke the grants a booth invitation issued",
      description:
        "Revoke every live grant the named invitation minted, each with the full effect of a direct grant revocation. This is a distinct action from act_booth_revoke_invitation, which stops new redemptions and leaves issued grants standing. The credential must be the booth's creator credential (the creator-management grant).",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
        invitationId: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.revokeInvitationGrants(args.invitationId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_request_access",
    {
      title: "File an access request for a booth",
      description:
        "File a bounded access request against a locked or invitation-only booth on behalf of a caller who holds the booth's URL but cannot unlock it. No credential is involved, and the request grants nothing and admits no one: it is a note for the booth's creator, who reads it under the creator-management grant and acts on it, if at all, by issuing an invitation. The label and message are self-declared and are not verified identity. A link-only booth refuses the filing (its link is the admission), as does a booth whose creator cannot retrieve requests.",
      inputSchema: {
        boothId: z.string().min(1),
        label: z.string().max(120).optional(),
        message: z.string().max(1000).optional(),
        role: z.enum(["sender", "recipient", "participant"]).optional(),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
        });
        return textResult(
          await booth.requestAccess({
            label: args.label,
            message: args.message,
            role: args.role,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_booth_list_access_requests",
    {
      title: "List a booth's access requests",
      description:
        "List a booth's access requests in filing order. The credential must be the booth's creator credential (the creator-management grant); a participant credential does not authorize this list.",
      inputSchema: {
        boothId: z.string().min(1),
        credential: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const booth = new BoothClient({
          baseUrl: client.serviceBaseUrl,
          boothId: args.boothId,
          credential: args.credential,
        });
        return textResult(await booth.listAccessRequests());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_get_receipt",
    {
      title: "Get a verification receipt",
      description: "Return one verification receipt by id.",
      inputSchema: { receiptId: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.getReceipt(args.receiptId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // Webhooks (Living Network Phase 2): account-owned outbound event
  // delivery, managed with the same API token as the transfer tools.
  // The signing secret comes back once, from act_webhook_create;
  // no other tool returns it.

  server.registerTool(
    "act_webhook_list",
    {
      title: "List the account's webhooks",
      description:
        "List the webhooks owned by the API token's account: target URL, scope, event filter, and status. Secrets are never returned.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await client.listWebhooks());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_webhook_create",
    {
      title: "Create a webhook",
      description:
        "Register an HTTPS endpoint to receive signed Moonbooth event envelopes (coordination events, conflicts, derived signals, booth lifecycle). Returns the webhook and its signing secret, shown once: store the secret to verify the Moonbooth-Signature header (HMAC-SHA-256 over \"<timestamp>.<body>\"). Omit eventTypes to receive every event. Pass boothId plus a participantCredential for that booth to scope the webhook to one booth; the API refuses a booth scope the account has no standing in.",
      inputSchema: {
        url: z.string().min(1),
        eventTypes: z.array(z.string()).optional(),
        boothId: z.string().optional(),
        participantCredential: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return textResult(
          await client.createWebhook({
            url: args.url,
            eventTypes: args.eventTypes,
            boothId: args.boothId,
            participantCredential: args.participantCredential,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_webhook_delete",
    {
      title: "Delete a webhook",
      description:
        "Delete one of the account's webhooks and its delivery log. Queued deliveries for it are dropped.",
      inputSchema: { webhookId: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.deleteWebhook(args.webhookId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_webhook_test",
    {
      title: "Send a test delivery to a webhook",
      description:
        "Enqueue one signed webhook.test envelope to the webhook's target so the owner can verify their receiver and signature check. Recorded in the delivery log.",
      inputSchema: { webhookId: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.testWebhook(args.webhookId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_webhook_deliveries",
    {
      title: "Read a webhook's delivery log",
      description:
        "Return recent delivery attempts for one webhook: kind, event type, attempt number, state (delivered, failed, dead), HTTP status or error category.",
      inputSchema: { webhookId: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async (args) => {
      try {
        return textResult(await client.listWebhookDeliveries(args.webhookId, args.limit));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // Persistent booths, namespaces, aliases (Living Network Phase 7):
  // account-owned booths that do not expire, administered with the
  // same API token as the webhook tools. The token carries exactly
  // its owner's powers over its owner's own booths. An alias is a
  // locator, never a credential.

  const boothAction = (
    name: string,
    title: string,
    description: string,
    run: (id: string) => Promise<unknown>,
  ) => {
    server.registerTool(
      name,
      { title, description, inputSchema: { boothId: z.string().min(1) } },
      async (args) => {
        try {
          return textResult(await run(args.boothId));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  };

  server.registerTool(
    "act_namespace_get",
    {
      title: "Read the account's namespace",
      description:
        "Return the API token account's namespace (@name), or null when the account has not claimed one. One namespace per account.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await client.getNamespace());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_namespace_claim",
    {
      title: "Claim the account's namespace",
      description:
        "Claim the account's one namespace by slug (lowercase letters, digits, hyphens, underscores). Refused when the account already holds one, the slug is taken or in its 30-day cooldown, or the name is reserved.",
      inputSchema: { slug: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.claimNamespace(args.slug));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_namespace_rename",
    {
      title: "Rename the account's namespace",
      description:
        "Rename the account's namespace, at most once every 30 days. The old name sits in a 30-day cooldown; aliases keep working because they hang off the namespace record, not its slug.",
      inputSchema: { slug: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.renameNamespace(args.slug));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_persistent_booth_create",
    {
      title: "Create a persistent booth",
      description:
        "Create a booth owned by the API token's account that does not expire. Returns the booth and its creator credential, shown once. Pass accessMode password with a password (at least 10 characters) to create it locked, or generated_key to mint an admission secret (also shown once). Pass parentBoothId (a persistent booth the same account owns) to create the booth as that booth's child (Phase 8).",
      inputSchema: {
        displayName: z.string().optional(),
        objective: z.string().optional(),
        parentBoothId: z.string().min(1).optional(),
        accessMode: z.enum(["link_only", "generated_key", "password", "invitation_only"]).optional(),
        password: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return textResult(
          await client.createPersistentBooth({
            displayName: args.displayName,
            objective: args.objective,
            parentBoothId: args.parentBoothId,
            accessMode: args.accessMode,
            password: args.password,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_persistent_booth_list",
    {
      title: "List the account's persistent booths",
      description:
        "List the persistent booths the API token's account owns, with lifecycle state and active alias. Temporary booths are never listed: they have no account owner.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await client.listOwnedBooths());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  boothAction("act_persistent_booth_get", "Read a persistent booth", "Return one of the account's persistent booths in owner view. A booth the account does not own reads as not found.", (id) => client.getOwnedBooth(id));
  boothAction("act_persistent_booth_close", "Close a persistent booth", "Close one of the account's persistent booths: mutation stops, reads keep working.", (id) => client.closeOwnedBooth(id));
  boothAction("act_persistent_booth_archive", "Archive a persistent booth", "Archive-mark one of the account's persistent booths. The booth stays readable and can be restored.", (id) => client.archiveOwnedBooth(id));
  boothAction("act_persistent_booth_restore", "Restore a persistent booth", "Clear the archive mark on one of the account's persistent booths. A deleted booth cannot be restored.", (id) => client.restoreOwnedBooth(id));
  boothAction("act_persistent_booth_delete", "Delete a persistent booth", "Delete one of the account's persistent booths: it stops resolving everywhere and its aliases are released, but its records are retained and its export still reads.", (id) => client.deleteOwnedBooth(id));
  boothAction("act_persistent_booth_export", "Export a persistent booth", "Export the full record of one of the account's persistent booths: booth, participants (hashes only), event log, receipts, subscriptions, signals, deliveries, audit events.", (id) => client.exportOwnedBooth(id));
  boothAction("act_persistent_booth_rotate_credentials", "Rotate a persistent booth's credentials", "Replace every live participant credential on one of the account's persistent booths, including transfer-role credentials. The new credentials are returned once; the old ones stop working immediately.", (id) => client.rotateOwnedBoothCredentials(id));

  server.registerTool(
    "act_persistent_booth_configure",
    {
      title: "Configure a persistent booth",
      description:
        "Set display name, objective, and limits on one of the account's persistent booths. limits.maxParticipants (1 to the plan cap) replaces the default participant cap at join time; limits.retentionDays (null, or 1 to 3650) is the window after which the cleanup sweep archive-marks the closed booth.",
      inputSchema: {
        boothId: z.string().min(1),
        displayName: z.string().nullable().optional(),
        objective: z.string().nullable().optional(),
        maxParticipants: z.number().int().nullable().optional(),
        retentionDays: z.number().int().nullable().optional(),
      },
    },
    async (args) => {
      try {
        return textResult(
          await client.configureOwnedBooth(args.boothId, {
            displayName: args.displayName,
            objective: args.objective,
            limits: { maxParticipants: args.maxParticipants, retentionDays: args.retentionDays },
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_persistent_booth_revoke_participant",
    {
      title: "Revoke a participant of a persistent booth",
      description:
        "Revoke one participant of one of the account's persistent booths: the participant row is deleted, its sessions end, and a transfer role can be claimed again by a fresh join.",
      inputSchema: { boothId: z.string().min(1), participantId: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.revokeOwnedBoothParticipant(args.boothId, args.participantId));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_alias_claim",
    {
      title: "Claim an alias for a persistent booth",
      description:
        "Claim an alias (@namespace/slug) for one of the account's persistent booths inside the account's namespace. Requires a claimed namespace; a booth carries at most one active alias in v1.",
      inputSchema: { boothId: z.string().min(1), slug: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.claimBoothAlias(args.boothId, args.slug));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "act_alias_rename",
    {
      title: "Rename a persistent booth's alias",
      description:
        "Rename the alias of one of the account's persistent booths. The old slug sits in a 30-day cooldown. Subscriptions and event references key on ids, not names, so nothing breaks.",
      inputSchema: { boothId: z.string().min(1), slug: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.renameBoothAlias(args.boothId, args.slug));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  boothAction("act_alias_release", "Release a persistent booth's alias", "Release the alias of one of the account's persistent booths into the 30-day cooldown, during which only this account can claim the name again.", (id) => client.releaseBoothAlias(id));

  server.registerTool(
    "act_alias_resolve",
    {
      title: "Resolve an alias",
      description:
        "Resolve an alias (@namespace/slug) to its booth's public discovery document: exactly what an unauthenticated read of the booth address discloses. An alias is a locator, never a credential.",
      inputSchema: { namespace: z.string().min(1), slug: z.string().min(1) },
    },
    async (args) => {
      try {
        return textResult(await client.resolveAlias(args.namespace, args.slug));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/** Build a server from ACT_API_URL / ACT_API_TOKEN in the environment. */
export function createActMcpServerFromEnv(): McpServer {
  const baseUrl = process.env.ACT_API_URL ?? "http://localhost:3000";
  const token = process.env.ACT_API_TOKEN ?? "";
  // With no token, tools return the API's 401 as an error result; the
  // handshake and tools/list still work so the setup can be checked.
  const client = new ActClient({
    baseUrl,
    token: token || "act_missing_token",
  });
  return createActMcpServer(client);
}
