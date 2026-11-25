// TypeScript SDK for the ACT hosted API.
//
// ActClient wraps the REST API under /api/v1. It authenticates with a
// personal API token (Authorization: Bearer <token>). Create a token on
// the dashboard of the hosted service. A token carries the owning
// user's identity only; there are no scopes in v0.1.
//
// Response shapes mirror the JSON returned by the route handlers in
// apps/web/src/app/api/v1.

export const PACKAGE_NAME = "@moonbooth/sdk";

/** Structured error returned by the API: { error: { code, message, details? } }. */
export class ActApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ActApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ActClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  fetchFn?: FetchFn;
}

// ---------------------------------------------------------------------------
// API shapes (mirror the route handlers)
// ---------------------------------------------------------------------------

export interface CapabilitySummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  createdAt?: string;
  versions?: Array<{ id: string; version: string; digest: string; createdAt: string }>;
}

export interface CreateCapabilityInput {
  mode: "paste" | "document" | "skill";
  name: string;
  description: string;
  version?: string;
  content?: string;
  fileName?: string;
  files?: Array<{ path: string; content: string }>;
  tools?: string[];
  permissions?: {
    network?: boolean;
    filesystem_write?: boolean;
    external_side_effects?: boolean;
  };
}

export interface CreatedCapability {
  capability: { id: string; slug: string; name: string; description: string };
  version: { id: string; version: string; digest: string };
  artifactId: string;
  blocked: boolean;
  scanFindings: unknown[];
}

export interface CapabilityDetail {
  capability: CapabilitySummary;
  versions: Array<{
    id: string;
    version: string;
    digest: string;
    manifest: unknown;
    artifactId: string | null;
    blocked: boolean;
    scanFindings: unknown[];
    createdAt: string;
  }>;
}

export interface TransferSummary {
  id: string;
  state: string;
  verificationState: string;
  capabilityName: string;
  version: string;
  digest: string;
  direction: "sent" | "received";
  blocked: boolean;
  scanFindings: unknown[];
  recipientEmail: string | null;
  senderId: string;
  recipientId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApproveResult {
  transfer: { id: string; state: string };
  invitation: { token: string; path: string; expiresAt: string };
}

export interface PackageView {
  transfer: { id: string; state: string };
  manifest: unknown;
  digest: string;
  files: Array<{ path: string; content: string }>;
  serialized: string;
  scanFindings: unknown[];
  blocked: boolean;
}

export interface Offer {
  transferId: string;
  state: string;
  senderDisplayName: string;
  capabilityName: string;
  capabilityDescription: string;
  version: string;
  recipientEmail: string | null;
  expiresAt: string;
  expired: boolean;
  revoked: boolean;
}

export interface ShareLinkSummary {
  id: string;
  transferId: string;
  capabilityName: string;
  version: string;
  digest: string;
  status: string;
  transferState: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
}

export interface CreatedShareLink {
  link: { id: string; path: string; url: string; expiresAt: string; status: string };
  transfer: { id: string; state: string };
}

/** Returned (as ActApiError details) when a link is refused because
 * the transfer is not approved yet. */
export interface NeedsApprovalDetails {
  transferId: string;
  digest: string;
  summary: unknown;
}

export interface LinkInspect {
  link: { id: string; status: string; expiresAt: string };
  capability?: { name: string; description?: string; version?: string; digest?: string };
  [key: string]: unknown;
}

export interface VerificationRunStart {
  id: string;
  transferId: string;
  status: string;
}

export interface VerificationView {
  run: {
    id: string;
    status: string;
    suiteId: string;
    suiteVersion: string;
    environment: unknown;
    results: unknown;
    startedAt: string | null;
    finishedAt: string | null;
  };
  receipt: { id: string; digest: string; receipt: unknown } | null;
}

export interface ReceiptView {
  id: string;
  digest: string;
  transferId: string;
  receipt: unknown;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ActClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;

  constructor(options: ActClientOptions) {
    if (!options.baseUrl) throw new Error("ActClient requires a baseUrl.");
    if (!options.token) throw new Error("ActClient requires a token.");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  }

  /** The service base URL this client was constructed with. */
  get serviceBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await this.fetchFn(`${this.baseUrl}${path}`, init);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (data?.error ?? {}) as { code?: string; message?: string; details?: unknown };
      throw new ActApiError(
        res.status,
        err.code ?? "unknown_error",
        err.message ?? `Request failed with status ${res.status}.`,
        err.details,
      );
    }
    return data as T;
  }

  // Capabilities -----------------------------------------------------------

  async createCapability(input: CreateCapabilityInput): Promise<CreatedCapability> {
    return this.request<CreatedCapability>("POST", "/api/v1/capabilities", input);
  }

  async listCapabilities(): Promise<{ capabilities: CapabilitySummary[] }> {
    return this.request("GET", "/api/v1/capabilities");
  }

  async getCapability(id: string): Promise<CapabilityDetail> {
    return this.request("GET", `/api/v1/capabilities/${encodeURIComponent(id)}`);
  }

  // Transfers --------------------------------------------------------------

  async createTransfer(input: {
    capabilityVersionId: string;
    recipientEmail?: string;
  }): Promise<{ transfer: TransferSummary }> {
    return this.request("POST", "/api/v1/transfers", input);
  }

  async getTransfer(id: string): Promise<{ transfer: TransferSummary }> {
    return this.request("GET", `/api/v1/transfers/${encodeURIComponent(id)}`);
  }

  async listTransfers(): Promise<{ transfers: TransferSummary[] }> {
    return this.request("GET", "/api/v1/transfers");
  }

  /** Sender approval. The digest must be the digest the sender reviewed. */
  async approveTransfer(
    id: string,
    digest: string,
    recipientEmail?: string,
  ): Promise<ApproveResult> {
    return this.request("POST", `/api/v1/transfers/${encodeURIComponent(id)}/approve`, {
      digest,
      ...(recipientEmail ? { recipientEmail } : {}),
    });
  }

  async revokeTransfer(id: string): Promise<{ transfer: { id: string; state: string } }> {
    return this.request("POST", `/api/v1/transfers/${encodeURIComponent(id)}/revoke`, {});
  }

  async getPackage(id: string): Promise<PackageView> {
    return this.request("GET", `/api/v1/transfers/${encodeURIComponent(id)}/package`);
  }

  async acceptTransfer(id: string): Promise<{ transfer: { id: string; state: string } }> {
    return this.request("POST", `/api/v1/transfers/${encodeURIComponent(id)}/accept`, {});
  }

  async rejectTransfer(
    id: string,
    reason?: string,
  ): Promise<{ transfer: { id: string; state: string } }> {
    return this.request("POST", `/api/v1/transfers/${encodeURIComponent(id)}/reject`, {
      ...(reason ? { reason } : {}),
    });
  }

  // Invitations --------------------------------------------------------------

  async getOffer(token: string): Promise<{ offer: Offer }> {
    return this.request("GET", `/api/v1/invitations/${encodeURIComponent(token)}`);
  }

  async receiveInvitation(
    token: string,
  ): Promise<{ transfer: { id: string; state: string } }> {
    return this.request(
      "POST",
      `/api/v1/invitations/${encodeURIComponent(token)}/receive`,
      {},
    );
  }

  // Share links --------------------------------------------------------------

  /**
   * Create a share link. Name a transferId (the transfer must already
   * be approved and offered; an unapproved transfer fails with an
   * ActApiError whose code is "needs_approval" and whose details carry
   * the package digest and a contents summary), or a
   * capabilityVersionId with the digest the sender reviewed (approval
   * is recorded as part of creation).
   */
  async createShareLink(input: {
    transferId?: string;
    capabilityVersionId?: string;
    digest?: string;
  }): Promise<CreatedShareLink> {
    return this.request("POST", "/api/v1/links", input);
  }

  async listShareLinks(): Promise<{ links: ShareLinkSummary[] }> {
    return this.request("GET", "/api/v1/links");
  }

  async revokeShareLink(id: string): Promise<{ link: { id: string; revokedAt: string | null } }> {
    return this.request("POST", "/api/v1/links/revoke", { id });
  }

  /** Read the public rendezvous document for a link token. */
  async inspectShareLink(token: string): Promise<LinkInspect> {
    return this.request("GET", `/api/v1/links/${encodeURIComponent(token)}`);
  }

  /** Claim a link as the token owner (an account claim). */
  async claimShareLink(
    token: string,
  ): Promise<{ transfer: { id: string; state: string }; claim: { kind: string; linkId: string } }> {
    return this.request("POST", `/api/v1/links/${encodeURIComponent(token)}/claim`, {});
  }

  // Verification -------------------------------------------------------------

  async requestVerification(
    transferId: string,
    profile?: unknown,
  ): Promise<{ run: VerificationRunStart }> {
    return this.request(
      "POST",
      `/api/v1/transfers/${encodeURIComponent(transferId)}/verify`,
      profile !== undefined ? { profile } : {},
    );
  }

  async getVerification(transferId: string): Promise<VerificationView> {
    return this.request(
      "GET",
      `/api/v1/transfers/${encodeURIComponent(transferId)}/verification`,
    );
  }

  async getReceipt(receiptId: string): Promise<ReceiptView> {
    return this.request("GET", `/api/v1/receipts/${encodeURIComponent(receiptId)}`);
  }

  // Webhooks ---------------------------------------------------------------
  //
  // Account-owned outbound event delivery (Living Network Phase 2).
  // A webhook registers a target URL and an event filter; the
  // service POSTs a signed envelope when a matching event lands in a
  // covered booth. The signing secret is returned once, by create
  // and by rotateWebhookSecret; no other method returns it.

  /** Register a webhook. The returned secret is shown once: store it now. */
  async createWebhook(input: CreateWebhookInput): Promise<{ webhook: WebhookView; secret: string }> {
    return this.request("POST", "/api/v1/webhooks", {
      url: input.url,
      ...(input.eventTypes !== undefined ? { event_types: input.eventTypes } : {}),
      ...(input.boothId !== undefined ? { booth_id: input.boothId } : {}),
      ...(input.participantCredential !== undefined
        ? { participant_credential: input.participantCredential }
        : {}),
    });
  }

  async listWebhooks(): Promise<{ webhooks: WebhookView[] }> {
    return this.request("GET", "/api/v1/webhooks");
  }

  async getWebhook(id: string): Promise<{ webhook: WebhookView }> {
    return this.request("GET", `/api/v1/webhooks/${encodeURIComponent(id)}`);
  }

  async updateWebhook(
    id: string,
    patch: UpdateWebhookInput,
  ): Promise<{ webhook: WebhookView }> {
    return this.request("PATCH", `/api/v1/webhooks/${encodeURIComponent(id)}`, {
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.eventTypes !== undefined ? { event_types: patch.eventTypes } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
  }

  /** Replace the signing secret. The new secret is shown once. */
  async rotateWebhookSecret(id: string): Promise<{ webhook: WebhookView; secret: string }> {
    return this.request("POST", `/api/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`, {});
  }

  async deleteWebhook(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/api/v1/webhooks/${encodeURIComponent(id)}`);
  }

  /** Enqueue one signed test delivery to the webhook's target. */
  async testWebhook(id: string): Promise<{ delivery_id: string }> {
    return this.request("POST", `/api/v1/webhooks/${encodeURIComponent(id)}/test`, {});
  }

  async listWebhookDeliveries(
    id: string,
    limit?: number,
  ): Promise<{ deliveries: WebhookDeliveryView[] }> {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return this.request("GET", `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries${query}`);
  }

  // Persistent booths, namespaces, aliases ---------------------------------
  //
  // Living Network Phase 7. A persistent booth is account-owned and
  // does not expire; the account administers it through these methods
  // (an API token carries exactly its owner's powers over its owner's
  // own booths). The account claims one namespace; a persistent booth
  // carries at most one alias inside it. An alias is a locator, never
  // a credential: resolving one returns the booth's public discovery
  // document.

  /** The account's namespace, or null when none is claimed. */
  async getNamespace(): Promise<{ namespace: NamespaceView | null }> {
    return this.request("GET", "/api/v1/account/namespace");
  }

  /** Claim the account's one namespace. */
  async claimNamespace(slug: string): Promise<{ namespace: NamespaceView }> {
    return this.request("POST", "/api/v1/account/namespace", { slug });
  }

  /** Rename the namespace (at most once every 30 days). */
  async renameNamespace(slug: string): Promise<{ namespace: NamespaceView }> {
    return this.request("PATCH", "/api/v1/account/namespace", { slug });
  }

  /** Create a persistent booth. The creator credential is shown once. */
  async createPersistentBooth(
    input: CreatePersistentBoothInput = {},
  ): Promise<{ booth: OwnedBoothView; creator_credential: string; admission_secret?: string | null }> {
    return this.request("POST", "/api/v1/account/booths", {
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.accessMode !== undefined ? { access_mode: input.accessMode } : {}),
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(input.invitations !== undefined ? { invitations: input.invitations } : {}),
      ...(input.parentBoothId !== undefined ? { parent_booth_id: input.parentBoothId } : {}),
    });
  }

  async listOwnedBooths(): Promise<{ booths: OwnedBoothView[] }> {
    return this.request("GET", "/api/v1/account/booths");
  }

  async getOwnedBooth(id: string): Promise<{ booth: OwnedBoothView }> {
    return this.request("GET", `/api/v1/account/booths/${encodeURIComponent(id)}`);
  }

  async configureOwnedBooth(
    id: string,
    patch: ConfigureOwnedBoothInput,
  ): Promise<{ booth: OwnedBoothView }> {
    return this.request("PATCH", `/api/v1/account/booths/${encodeURIComponent(id)}`, {
      ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
      ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
      ...(patch.limits !== undefined
        ? {
            limits: {
              ...(patch.limits.maxParticipants !== undefined
                ? { max_participants: patch.limits.maxParticipants }
                : {}),
              ...(patch.limits.retentionDays !== undefined
                ? { retention_days: patch.limits.retentionDays }
                : {}),
            },
          }
        : {}),
    });
  }

  /** Delete a persistent booth. Records are retained; the booth stops resolving. */
  async deleteOwnedBooth(id: string): Promise<{ booth: OwnedBoothView }> {
    return this.request("DELETE", `/api/v1/account/booths/${encodeURIComponent(id)}`);
  }

  async closeOwnedBooth(id: string): Promise<{ booth: OwnedBoothView }> {
    return this.request("POST", `/api/v1/account/booths/${encodeURIComponent(id)}/close`, {});
  }

  async archiveOwnedBooth(id: string): Promise<{ booth: OwnedBoothView }> {
    return this.request("POST", `/api/v1/account/booths/${encodeURIComponent(id)}/archive`, {});
  }

  async restoreOwnedBooth(id: string): Promise<{ booth: OwnedBoothView }> {
    return this.request("POST", `/api/v1/account/booths/${encodeURIComponent(id)}/restore`, {});
  }

  /** Rotate every live participant credential. The new credentials are shown once. */
  async rotateOwnedBoothCredentials(
    id: string,
  ): Promise<{ booth: OwnedBoothView; rotated: RotatedCredentialView[] }> {
    return this.request(
      "POST",
      `/api/v1/account/booths/${encodeURIComponent(id)}/rotate-credentials`,
      {},
    );
  }

  async revokeOwnedBoothParticipant(
    id: string,
    participantId: string,
  ): Promise<{ revoked: boolean; booth: OwnedBoothView }> {
    return this.request(
      "DELETE",
      `/api/v1/account/booths/${encodeURIComponent(id)}/participants/${encodeURIComponent(participantId)}`,
    );
  }

  /** The full booth record export (works on a deleted booth too). */
  async exportOwnedBooth(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/v1/account/booths/${encodeURIComponent(id)}/export`);
  }

  /**
   * Phase 10: read the booth's publication policy — what this
   * booth publishes to other booths. A null publication publishes
   * nothing. Only account-owned booths can be cross-booth sources.
   */
  async getPublicationPolicy(id: string): Promise<BoothPublicationPolicyView> {
    return this.request("GET", `/api/v1/account/booths/${encodeURIComponent(id)}/publication`);
  }

  /** Set (replace in full) the booth's publication policy. */
  async setPublicationPolicy(
    id: string,
    input: { subjects?: string[]; eventTypes?: string[] | null },
  ): Promise<BoothPublicationPolicyView> {
    return this.request("PUT", `/api/v1/account/booths/${encodeURIComponent(id)}/publication`, {
      ...(input.subjects !== undefined ? { subjects: input.subjects } : {}),
      ...(input.eventTypes !== undefined ? { event_types: input.eventTypes } : {}),
    });
  }

  /** Clear the booth's publication policy; the booth publishes nothing. */
  async clearPublicationPolicy(id: string): Promise<BoothPublicationPolicyView> {
    return this.request("DELETE", `/api/v1/account/booths/${encodeURIComponent(id)}/publication`);
  }

  async getBoothAlias(id: string): Promise<{ alias: BoothAliasView | null }> {
    return this.request("GET", `/api/v1/account/booths/${encodeURIComponent(id)}/alias`);
  }

  async claimBoothAlias(id: string, slug: string): Promise<{ alias: BoothAliasView }> {
    return this.request("POST", `/api/v1/account/booths/${encodeURIComponent(id)}/alias`, { slug });
  }

  async renameBoothAlias(id: string, slug: string): Promise<{ alias: BoothAliasView }> {
    return this.request("PATCH", `/api/v1/account/booths/${encodeURIComponent(id)}/alias`, { slug });
  }

  async releaseBoothAlias(id: string): Promise<{ alias: BoothAliasView }> {
    return this.request("DELETE", `/api/v1/account/booths/${encodeURIComponent(id)}/alias`);
  }

  /** Resolve an alias (@namespace/slug) to its booth's public discovery document. */
  async resolveAlias(
    namespace: string,
    slug: string,
  ): Promise<{ alias: string; booth: Record<string, unknown> }> {
    return this.request(
      "GET",
      `/api/v1/aliases/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`,
    );
  }
}

/** The account's namespace view (Phase 7). */
export interface NamespaceView {
  name: string;
  slug: string;
  created_at: string;
  renamed_at: string | null;
}

/** A persistent booth in its owner's admin view (Phase 7). */
/**
 * A booth's cross-booth publication policy (Living Network
 * Phase 10): the subject prefixes and event types the booth
 * publishes to other booths. A null publication publishes nothing.
 */
export interface BoothPublicationPolicyView {
  booth_id: string;
  publication: { subjects: string[]; event_types: string[] | null } | null;
}

export interface OwnedBoothView {
  id: string;
  url: string;
  kind: string;
  status: string;
  lifecycle: Record<string, unknown>;
  name: string | null;
  objective: string | null;
  alias: string | null;
  access_mode: string;
  created_at: string;
  expires_at: string | null;
  closed_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  limits: { max_participants?: number | null; retention_days?: number | null } | null;
}

/** An alias naming one persistent booth inside a namespace (Phase 7). */
export interface BoothAliasView {
  name: string;
  namespace: string;
  slug: string;
  booth_id: string;
  url: string;
  status: string;
  created_at: string;
  released_at: string | null;
}

export interface CreatePersistentBoothInput {
  displayName?: string;
  objective?: string;
  accessMode?: "link_only" | "generated_key" | "password" | "invitation_only";
  password?: string;
  invitations?: Array<Record<string, unknown>>;
  /**
   * Phase 8: create this booth as the child of a persistent booth the
   * same account owns (the parent's public id). The session is the
   * standing; a parent owned by another account reads as not found.
   */
  parentBoothId?: string;
}

export interface ConfigureOwnedBoothInput {
  displayName?: string | null;
  objective?: string | null;
  limits?: { maxParticipants?: number | null; retentionDays?: number | null };
}

/** One rotated participant credential, shown once by rotateOwnedBoothCredentials. */
export interface RotatedCredentialView {
  participant_id: string;
  kind: string;
  transfer_role: string | null;
  credential: string;
}

/** The metadata view of an account webhook. Never carries the secret or its stored form. */
export interface WebhookView {
  id: string;
  url: string;
  scope: "booth" | "account";
  booth_id: string | null;
  event_types: string[] | null;
  status: "active" | "paused";
  last_delivery_at: string | null;
  created_at: string;
  updated_at: string;
  paused_at: string | null;
}

export interface CreateWebhookInput {
  url: string;
  /** Filter entries from the webhook vocabulary; omit or null for every event. */
  eventTypes?: string[] | null;
  /** A booth's public id, to scope the webhook to that booth. */
  boothId?: string | null;
  /** A participant credential for the named booth, proving the account takes part in it. */
  participantCredential?: string | null;
}

export interface UpdateWebhookInput {
  url?: string;
  eventTypes?: string[] | null;
  status?: "active" | "paused";
}

export interface WebhookDeliveryView {
  id: string;
  delivery_id: string;
  webhook_id: string;
  booth_id: string | null;
  event_id: string | null;
  signal_key: string | null;
  event_type: string;
  kind: "event" | "signal" | "lifecycle" | "test";
  attempt: number;
  state: "delivered" | "failed" | "dead";
  status_code: number | null;
  error_category: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Booths (Moonbooth)
// ---------------------------------------------------------------------------
//
// A booth is an anonymous rendezvous: no account token is involved.
// The credential a participant receives at join time is the only
// credential, and it is scoped to the one booth. BoothClient carries
// one booth id and, after a join, the credential that join returned.

/** One invitation to issue at creation or through the invitations endpoint (Locked Booths L3). */
export interface BoothInvitationSpec {
  /** The role a redemption joins under; "participant" (or omitting it) leaves the role to the redemption. */
  role?: "sender" | "recipient" | "participant";
  /** The permission subset the redeemed credential carries. Defaults to the bound role's default set. */
  scopes?: string[];
  label?: string;
  subjectRestrictions?: string[];
  maxRedemptions?: number;
  expiresInSeconds?: number;
}

/** The metadata view of a booth invitation. Never carries the token or its hash. */
export interface BoothInvitationView {
  id: string;
  booth_id: string;
  issuer: { kind: "creator" | "participant"; participant_id?: string | null };
  role_binding: string | null;
  scopes: string[];
  subject_restrictions: string[] | null;
  label: string | null;
  max_redemptions: number;
  redemption_count: number;
  state: "active" | "revoked" | "expired" | "exhausted";
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** The metadata view of a participant grant (Locked Booths L4). Never carries the credential or its hash. */
export interface BoothParticipantView {
  id: string;
  kind: "transfer" | "participant";
  transfer_role: string | null;
  display_name: string | null;
  permissions: string[];
  invitation_id: string | null;
  issuer_participant_id: string | null;
  subject_restrictions: string[] | null;
  state: "active" | "revoked" | "expired";
  joined_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** The result of rotating a booth's admission secret (L4). admission_secret is present only for a generated-key rotation. */
export interface BoothRotateSecretResult {
  admission_method: "generated_key" | "password";
  admission_secret?: string;
  admission_secret_note: string;
  access: unknown;
}

/** The result of protecting a link-only booth (L5). admission_secret is present only for a generated key, and shown once. */
export interface BoothProtectResult {
  admission_method: "generated_key" | "password";
  admission_secret?: string;
  admission_secret_note: string;
  access: unknown;
}

/** One access request (Locked Booths L4). Filing grants nothing and admits no one. */
export interface BoothAccessRequestView {
  id: string;
  booth_id: string;
  label: string | null;
  message: string | null;
  requested_role: string | null;
  status: "pending";
  created_at: string;
}

/** An invitation as returned at issuance: the metadata view plus its one-time token. */
export interface BoothInvitationIssuedView extends BoothInvitationView {
  /** The invitation token (mbi_ prefix), shown once. Presenting it at unlock redeems the invitation. */
  token: string;
}

export interface BoothCreateResult {
  id: string;
  url: string;
  expires_at: string;
  ttl_seconds?: number;
  close_condition?: string | null;
  /** Shown once; authorizes closing the booth. Present on a fresh create only. */
  creator_credential?: string;
  /** Locked creation only: the access policy the booth was created with. */
  access?: unknown;
  /** Locked creation only: the admission method ("generated_key" or "password"). */
  admission_method?: string | null;
  /** Shown once, locked creation with a generated key only: the admission key. */
  admission_secret?: string | null;
  /** L3: invitations issued inside the create, each with its one-time token. */
  invitations?: BoothInvitationIssuedView[];
  /**
   * Phase 8: present when the booth was created as a child — the
   * parent's public id and the child booth's own URL.
   */
  parent?: { id: string; url: string };
  [key: string]: unknown;
}

export interface BoothJoinResult {
  role: string;
  participant_id?: string;
  credential: string;
  credential_note: string;
  discovery: unknown;
}

/** Phase 10: one cross-booth subscription as the API returns it. */
export interface BoothCrossSubscriptionView {
  id: string;
  source_booth_id: string;
  destination_booth_id: string;
  participant_id: string;
  subjects: string[];
  event_types: string[] | null;
  state: "active" | "revoked";
  created_at: string;
}

/** Phase 10: the create response — created is false when an identical active subscription already existed. */
export interface BoothCrossSubscriptionResult {
  subscription: BoothCrossSubscriptionView;
  created: boolean;
}

/** Phase 8: the publication record returned by the publish endpoint. */
export interface BoothPublishResult {
  /** The service-authored result_published event as it landed in the parent. */
  event: {
    id: string;
    seq: number;
    type: string;
    subject: string | null;
    payload: {
      child_booth_id: string;
      child_url: string;
      events: Array<{
        event_id: string;
        seq: number;
        type: string;
        subject: string | null;
        digest: string;
      }>;
      receipt?: { receipt_id: string; receipt_digest: string };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  parent: { id: string; url: string };
  child: { id: string };
  /** True when an idempotency key replayed the original publication. */
  replayed: boolean;
}

export interface BoothUnlockResult {
  role: string;
  participant_id?: string;
  credential: string;
  credential_note: string;
  /** Which admission method the secret matched: "generated_key", "password", or "invitation". */
  admission_method: string;
  discovery: unknown;
}

export interface BoothEventView {
  id: string;
  seq: number;
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  author: unknown;
  in_reply_to: string | null;
  related_ids: string[] | null;
  created_at: string;
  status?: string;
  status_reason?: string | null;
  /** Changes feed only: why this event surfaced for the caller. */
  reasons?: string[];
  relevance?: { reasons: string[] };
}

export interface BoothSubscriptionView {
  id: string;
  booth_id: string;
  participant_id: string;
  subjects: string[];
  /** The watchers declared on this subscription (Phase 6), in declaration order. */
  conditions: BoothWatcherView[];
  event_types: string[] | null;
  delivery_mode: string;
  delivered_cursor: number;
  acked_cursor: number;
  state: string;
  last_delivery_at: string | null;
  created_at: string;
}

/**
 * One watcher declaration (Living Network Phase 6): a typed
 * condition on the participant's subscription, from a closed set —
 * contract_changed { subject }, contract_version { subject, version },
 * commitment_deadline_within { window_seconds }, check_failed
 * { check_event_id | subject }, evidence_present
 * { subject, evidence_kind }, offer_on_subject { subject },
 * dependency_invalidated { subject }, booth_expiring_within
 * { window_seconds }. When the condition holds against the booth's
 * log, it derives as a signal with reason watcher_triggered.
 */
export interface BoothWatcherSpec {
  kind: string;
  subject?: string;
  version?: string;
  window_seconds?: number;
  check_event_id?: string;
  evidence_kind?: string;
}

export interface BoothWatcherView {
  id: string;
  kind: string;
  subject: string | null;
  version: string | null;
  window_seconds: number | null;
  check_event_id: string | null;
  evidence_kind: string | null;
  created_at: string;
}

export interface BoothWatchersView {
  watchers: BoothWatcherView[];
  subscription_id: string;
  participant_id: string;
}

export interface BoothChangesView {
  events: BoothEventView[];
  latest_seq: number;
  acked_seq: number;
  next_since: number;
  subscription: BoothSubscriptionView;
  wake: { poll_after_seconds: number; long_poll_max_seconds: number };
}

export interface BoothChangesOptions {
  since?: number;
  until?: number;
  mode?: "relevant" | "all";
  /** Hold the request open for a relevant event, up to 25 seconds server-side. */
  waitSeconds?: number;
}

export interface BoothStreamOptions {
  /** Resume from this seq; sent on the wire as the Last-Event-ID header. */
  since?: number;
  mode?: "relevant" | "all";
  /** Abort the stream from the client side. */
  signal?: AbortSignal;
}

/**
 * One frame of a booth event stream (Living Network Phase 13): an
 * open frame when the stream starts, one event frame per changes
 * entry as it lands, and an end frame naming why the stream closed
 * and the cursor to resume from.
 */
export type BoothStreamFrame =
  | { type: "open"; booth: string; since: number; mode: string; latest_seq: number }
  | { type: "event"; seq: number; event: BoothEventView }
  | { type: "end"; reason: string; next_since: number; latest_seq: number };

type ParsedStreamFrame = BoothStreamFrame | { type: "error"; code: string };

/** Parse one server-sent event block (the text between blank lines). */
export function parseStreamFrame(raw: string): ParsedStreamFrame | null {
  let id: string | undefined;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event === "stream_open") {
    return {
      type: "open",
      booth: String(data.booth ?? ""),
      since: Number(data.since ?? 0),
      mode: String(data.mode ?? "relevant"),
      latest_seq: Number(data.latest_seq ?? 0),
    };
  }
  if (event === "stream_end") {
    return {
      type: "end",
      reason: String(data.reason ?? ""),
      next_since: Number(data.next_since ?? 0),
      latest_seq: Number(data.latest_seq ?? 0),
    };
  }
  if (event === "stream_error") {
    return { type: "error", code: String(data.code ?? "stream_error") };
  }
  if (event === "booth_event") {
    const entry = data as unknown as BoothEventView;
    return { type: "event", seq: Number(id ?? entry.seq ?? 0), event: entry };
  }
  return null;
}

export interface BoothSignalView {
  signal_key: string;
  source_event_id: string;
  subject: string;
  participant_id: string;
  reason: string;
  severity: "high" | "medium" | "low";
  state_ref: number;
  created_from_seq: number;
  /** Watcher signals only (Phase 6): the declared condition that triggered. */
  watcher_id?: string;
  watcher_kind?: string;
}

export interface BoothSignalsView {
  signals: BoothSignalView[];
  latest_seq: number;
  counts: { pending: number; acknowledged: number; dismissed: number };
  participant_id: string;
}

/**
 * One typed condition in a commitment proposal (Living Network Phase 3).
 * The closed set the service can evaluate: contract_version
 * { subject, version }, event_exists { type, subject },
 * acks_complete { seq | subject }, digest_matches
 * { capability_version_id | subject, digest }, decision_accepted
 * { subject }, deadline { at }. Any other kind is accepted at
 * propose time and evaluates to requires_review — the commitment can
 * never read fulfilled on a condition the service cannot check.
 */
export interface BoothCommitmentConditionSpec {
  kind: string;
  subject?: string;
  version?: string;
  type?: string;
  seq?: number;
  capability_version_id?: string;
  digest?: string;
  at?: string;
  [key: string]: unknown;
}

export interface BoothCommitmentProposal {
  /** The commitment, in one line. Required. */
  title: string;
  /** The event subject the commitment hangs on. Defaults to the first of subjects, or "commitment". */
  subject?: string;
  /** Subjects the commitment concerns (contract subjects, capability subjects, decision subjects). */
  subjects?: string[];
  /** Participant ids or transfer roles ("sender", "recipient") the commitment binds. Every named party must endorse before the commitment can fulfill. */
  parties?: string[];
  /** The commitments themselves, as text. The service stores them verbatim and never interprets them. */
  commitments?: string[];
  /** Typed conditions the service evaluates against the booth log. */
  conditions?: BoothCommitmentConditionSpec[];
  /** ISO timestamp; a commitment whose conditions are unmet at its deadline reads failed (endorsed) or expired (not yet endorsed by every party). */
  dueAt?: string;
}

export interface BoothCommitmentConditionView extends BoothCommitmentConditionSpec {
  status: "met" | "unmet" | "requires_review";
  detail: string;
  satisfied_at: string | null;
}

export interface BoothCommitmentView {
  event_id: string;
  seq: number;
  subject: string;
  title: string | null;
  proposer_participant_id: string;
  parties: string[];
  party_participant_ids: string[];
  endorsed_by: string[];
  commitments: string[];
  conditions: BoothCommitmentConditionView[];
  due_at: string | null;
  status:
    | "proposed"
    | "endorsed"
    | "active"
    | "evidence_pending"
    | "fulfilled"
    | "failed"
    | "expired"
    | "cancelled"
    | "requires_review";
  status_reason: string | null;
  created_at: string;
}

/**
 * One typed assertion in a check declaration (Living Network
 * Phase 5). The set the service can evaluate: evidence_present
 * { evidence_kind, subject }, contract_versions_aligned
 * { subjects, version? }, digest_matches
 * { capability_version_id | subject, digest }, acks_complete
 * { seq | subject }, commitments_fulfilled { commitment_ids },
 * no_open_blocking_conflicts { subject? }. Any other kind is
 * accepted at declare time and evaluates to unsupported — a check
 * can never read passed on an assertion the service cannot
 * evaluate.
 */
export interface BoothCheckAssertionSpec {
  kind: string;
  evidence_kind?: string;
  subject?: string;
  subjects?: string[];
  version?: string;
  capability_version_id?: string;
  digest?: string;
  seq?: number;
  commitment_ids?: string[];
  [key: string]: unknown;
}

export interface BoothCheckTarget {
  kind: "booth" | "transfer" | "commitment" | "contract";
  /** Required when kind is "commitment": the commitment event the check is about. */
  commitment_event_id?: string;
  /** Required when kind is "contract": the contract subject the check is about. */
  subject?: string;
}

export interface BoothCheckSpec {
  /** What the check verifies, in one line. Required. */
  title: string;
  /** The event subject the check hangs on. Defaults to "check". */
  subject?: string;
  /** What the check is about. Defaults to the whole booth. */
  target?: BoothCheckTarget;
  /** Typed assertions the service evaluates against the booth log. Omit for a not_run check. */
  assertions?: BoothCheckAssertionSpec[];
}

export interface BoothAssertionView {
  kind: string;
  status: "passed" | "failed" | "incomplete" | "awaiting_evidence" | "unsupported";
  detail: string;
  /** self_reported: a participant's attestation. service_computed: derived by the service from records it holds. verified: receipt-backed. */
  assurance: "self_reported" | "service_computed" | "verified";
  /** The log events the evaluation relied on — the result's evidence citation. */
  evidence_event_ids: string[];
  receipt_id: string | null;
}

export interface BoothCheckView {
  check_event_id: string;
  seq: number;
  subject: string;
  title: string;
  target: { kind: string; commitment_event_id: string | null; subject: string | null };
  status: "passed" | "failed" | "incomplete" | "awaiting_evidence" | "not_run" | "unsupported";
  status_reason: string | null;
  assertions: BoothAssertionView[];
  author_participant_id: string | null;
  created_at: string;
  /** The log position this evaluation ran against. A re-read after new events is a new evaluation. */
  evaluated_seq: number;
}

export interface BoothCloseConditionResult {
  id: string;
  status: string;
  lifecycle: unknown;
  close_condition: string | null;
}

/**
 * Filters for the booth Brief (Living Network Phase 4): the state
 * cut to what the filters admit. Accepted and proposed material sit
 * in separate sections, every entry carries its source event id,
 * and the response's omitted block counts what the filters and
 * limits cut, with the reason.
 */
export interface BoothBriefOptions {
  /** Participant the brief is centered on; defaults to the caller. */
  participant?: string;
  /** Keep only records on this subject. */
  subject?: string;
  /** Keep only records authored by participants holding this role. */
  role?: "sender" | "recipient" | "participant";
  /** A participant id, or "caller": keep only subjects that participant depends on. */
  dependencyOf?: string;
  /** Keep only records with a sequence number greater than this. */
  since?: number;
  /** Most records kept per section (default 500 server-side). */
  maxRecords?: number;
  /** Byte budget for the serialized brief (default 1000000 server-side). */
  maxBytes?: number;
}

export interface BoothBriefView {
  booth: { id: string; status: string; expires_at: string };
  snapshot_seq: number;
  generated_at: string;
  filters_applied: {
    participant: string;
    subject: string | null;
    role: string | null;
    dependency_of: string | null;
    since: number;
    max_records: number;
    max_bytes: number;
  };
  participant: { participant_id: string; label: string; your_ack_seq: number };
  sections: {
    participants: Array<Record<string, unknown>>;
    intents: BoothEventView[];
    contracts: Array<Record<string, unknown>>;
    assumptions: BoothEventView[];
    decisions_accepted: BoothEventView[];
    decisions_proposed: BoothEventView[];
    commitments: Array<Record<string, unknown>>;
    conflicts_open: Array<Record<string, unknown>>;
    conflicts_resolved: Array<Record<string, unknown>>;
    capability_offers: BoothEventView[];
    checks: Array<Record<string, unknown>>;
    evidence: BoothEventView[];
  };
  omitted: Record<string, Array<{ count: number; reason: string }>>;
}

/**
 * One hypothetical event input for a What-If evaluation (Living
 * Network Phase 11): the append path's event shape, plus an
 * optional id label so a later input in the same evaluation can
 * reference this one (a decision_accept naming an earlier
 * hypothetical decision, for example).
 */
export interface BoothWhatIfEventInput {
  id?: string;
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  in_reply_to?: string;
  related_ids?: string[];
}

/**
 * The What-If delta (Living Network Phase 11): what would change
 * if the hypothetical events landed, computed from base_seq.
 * Every delta entry is labeled hypothetical and carries base_seq.
 * Nothing in the booth changed.
 */
export interface BoothWhatIfView {
  booth: { id: string; status: string };
  hypothetical: boolean;
  base_seq: number;
  evaluated_seq: number;
  hypothetical_events: Array<{ event_id: string; seq: number; type: string; subject: string }>;
  delta: {
    new_conflicts: Array<Record<string, unknown>>;
    competing_contracts: Array<Record<string, unknown>>;
    stale_assumptions: Array<Record<string, unknown>>;
    affected_participants: Array<Record<string, unknown>>;
    commitment_status_changes: Array<Record<string, unknown>>;
    check_status_changes: Array<Record<string, unknown>>;
  };
  /** The coverage boundary: declared dependencies and subject links only. */
  boundary: string;
  note: string;
  participant_id: string;
}

/**
 * A capsule selection (Living Network Phase 12): the records of a
 * booth's log a capsule freezes. At least one of eventIds,
 * subjects, or sections must be named; an event id that is not in
 * the log refuses the call rather than being silently dropped.
 * Sections: decisions (decision, decision_accept), contracts
 * (contract), findings (finding), conflicts (conflict), commitments
 * (commitment, commitment_accept, commitment_cancel), checks (check), capabilities
 * (capability_offer).
 */
export interface BoothCapsuleSelection {
  eventIds?: string[];
  subjects?: string[];
  sections?: Array<
    "decisions" | "contracts" | "findings" | "conflicts" | "commitments" | "checks" | "capabilities"
  >;
}

/** One manifest entry: a selected record named by type, id, sequence, and the digest of its serialized record. */
export interface BoothCapsuleManifestEntry {
  event_id: string;
  seq: number;
  type: string;
  subject: string;
  digest: string;
}

/**
 * The capsule preview (Living Network Phase 12): exactly what a
 * selection would include — the manifest entries, the Markdown
 * summary, and the digest the capsule would carry — with nothing
 * stored.
 */
export interface BoothCapsulePreview {
  booth: { id: string };
  selection: { event_ids: string[]; subjects: string[]; sections: string[] };
  preset: "temporary_org" | null;
  entries: BoothCapsuleManifestEntry[];
  counts: { events: number; by_type: Record<string, number> };
  digest: string;
  summary_markdown: string;
  contracts_visible: boolean;
  note: string;
}

/** A stored capsule: its id, digest, and manifest; the read form also carries the summary. */
export interface BoothCapsuleView {
  id: string;
  source_booth_id: string;
  created_by_participant_id: string | null;
  digest: string;
  created_at: string;
  manifest: Record<string, unknown>;
  summary_markdown?: string;
}

/**
 * An import's outcome (Living Network Phase 12): the records
 * imported (each naming its origin event id, the target event it
 * became, and whether the append was an idempotent replay) and
 * the records skipped, each with the reason it does not cross.
 */
export interface BoothCapsuleImportResult {
  capsule_id: string;
  origin_booth_id: string;
  target_booth_id: string;
  imported: Array<{
    origin_event_id: string;
    event_id: string;
    type: string;
    replayed: boolean;
  }>;
  skipped: Array<{ origin_event_id: string; type: string; reason: string }>;
  note: string;
}

/** A skill export's outcome (Living Network Phase 12): the new capability version and the provenance its package carries. */
export interface BoothCapsuleSkillExport {
  capability: { id: string; slug: string; name: string };
  version: { id: string; version: string; digest: string };
  artifact: { id: string; storage_key: string };
  provenance: Record<string, unknown>;
  verification_receipt_ids: string[];
}

export interface BoothReplayOptions {
  /** Compute the state over events with a sequence number at most this; defaults to the latest. */
  untilSeq?: number;
  /** Narrow the returned event slice to this subject. The state view is not narrowed. */
  subject?: string;
  /** Participant whose reached-changes derivation to include. */
  participant?: string;
}

export interface BoothReplayView {
  booth: { id: string; status: string; expires_at: string };
  as_of_seq: number;
  latest_seq: number;
  filters_applied: {
    until_seq: number | null;
    subject: string | null;
    participant: string | null;
  };
  /** The replay never asserts causation; this field says so, in the response. */
  causation_note: string;
  /** Ack cursors in the response are current values, not as of as_of_seq; this field says so. */
  ack_note: string;
  state: Record<string, unknown>;
  events: BoothEventView[];
  reached: {
    participant_id: string;
    entries: BoothEventView[];
    ack: { last_ack_seq: number; as_of: boolean; note: string };
  } | null;
}

export interface BoothAskOptions {
  /** Exact subject to look up. */
  subject?: string;
  /** Exact event type to restrict to. */
  type?: string;
  /** Substring matched over subjects and payload summary fields — not semantic search. */
  q?: string;
}

export interface BoothAskRecord extends BoothEventView {
  citation: { event_id: string; seq: number; author_label: string };
}

export interface BoothAskView {
  booth: { id: string };
  query: { subject: string | null; type: string | null; q: string | null };
  /** Per supplied parameter, how it matched: exact, or substring for q. */
  match: Record<string, string>;
  match_note: string;
  records: BoothAskRecord[];
  count: number;
}

function serializeInvitationSpec(spec: BoothInvitationSpec): Record<string, unknown> {
  return {
    ...(spec.role ? { role: spec.role } : {}),
    ...(spec.scopes ? { scopes: spec.scopes } : {}),
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.subjectRestrictions ? { subject_restrictions: spec.subjectRestrictions } : {}),
    ...(spec.maxRedemptions !== undefined ? { max_redemptions: spec.maxRedemptions } : {}),
    ...(spec.expiresInSeconds !== undefined ? { expires_in_seconds: spec.expiresInSeconds } : {}),
  };
}

/** Create a booth. Anonymous: no credential of any kind is sent. */
export async function createBooth(
  baseUrl: string,
  input: {
    ttlSeconds?: number;
    closeCondition?: string;
    /**
     * Lock the booth at creation: { mode: "locked", method:
     * "generated_key" } returns the admission key once in
     * admission_secret; { mode: "locked", method: "password",
     * password } sets a human password the service never echoes.
     * { mode: "invitation_only" } creates a booth with no shared
     * admission secret, entered only by redeeming an invitation. On
     * either non-default mode, invitations issues the creator's first
     * invitations inside the create; their tokens return once in the
     * result's invitations. Omit for a link-only booth.
     */
    access?: {
      mode: string;
      method?: string;
      password?: string;
      defaultScopes?: string[];
      invitations?: BoothInvitationSpec[];
    };
    /**
     * Phase 8: create this booth as the child of a parent booth.
     * boothId is the parent's public id or its @namespace/slug alias;
     * credential proves standing in the parent (a parent participant
     * credential or the parent's creator credential). Omit credential
     * only when the call itself carries the parent owner's account
     * session. A refused parent creates nothing.
     */
    parent?: { boothId: string; credential?: string };
  } = {},
  fetchFn?: FetchFn,
): Promise<BoothCreateResult> {
  const doFetch = fetchFn ?? ((url: string, init: RequestInit) => fetch(url, init));
  const body: Record<string, unknown> = {};
  if (input.ttlSeconds !== undefined) body.ttl_seconds = input.ttlSeconds;
  if (input.closeCondition !== undefined) body.close_condition = input.closeCondition;
  if (input.access !== undefined) {
    body.access = {
      mode: input.access.mode,
      ...(input.access.method ? { method: input.access.method } : {}),
      ...(input.access.password ? { password: input.access.password } : {}),
      ...(input.access.defaultScopes ? { default_scopes: input.access.defaultScopes } : {}),
      ...(input.access.invitations
        ? { invitations: input.access.invitations.map(serializeInvitationSpec) }
        : {}),
    };
  }
  if (input.parent !== undefined) {
    body.parent = {
      booth_id: input.parent.boothId,
      ...(input.parent.credential ? { credential: input.parent.credential } : {}),
    };
  }
  const res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/api/v1/booths`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data?.error ?? {}) as { code?: string; message?: string; details?: unknown };
    throw new ActApiError(
      res.status,
      err.code ?? "unknown_error",
      err.message ?? `Request failed with status ${res.status}.`,
      err.details,
    );
  }
  return data as unknown as BoothCreateResult;
}

export interface BoothClientOptions {
  baseUrl: string;
  boothId: string;
  /** A booth credential from a join. Optional until a join happens. */
  credential?: string;
  fetchFn?: FetchFn;
}

export class BoothClient {
  private readonly baseUrl: string;
  private readonly boothId: string;
  private credential: string | undefined;
  private readonly fetchFn: FetchFn;

  constructor(options: BoothClientOptions) {
    if (!options.baseUrl) throw new Error("BoothClient requires a baseUrl.");
    if (!options.boothId) throw new Error("BoothClient requires a boothId.");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.boothId = options.boothId;
    this.credential = options.credential;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  }

  /** The credential this client sends, once a join has provided one. */
  get currentCredential(): string | undefined {
    return this.credential;
  }

  private async request<T>(
    method: string,
    suffix: string,
    body?: unknown,
    credentialOverride?: string,
  ): Promise<T> {
    const credential = credentialOverride ?? this.credential;
    const init: RequestInit = {
      method,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await this.fetchFn(
      `${this.baseUrl}/api/v1/booths/${encodeURIComponent(this.boothId)}${suffix}`,
      init,
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (data?.error ?? {}) as { code?: string; message?: string; details?: unknown };
      throw new ActApiError(
        res.status,
        err.code ?? "unknown_error",
        err.message ?? `Request failed with status ${res.status}.`,
        err.details,
      );
    }
    return data as T;
  }

  /** The booth's discovery document (no credential required). */
  async discovery<T = unknown>(): Promise<T> {
    return this.request<T>("GET", "");
  }

  /**
   * Phase 8: publish this child booth's results to its parent. This
   * client's credential is the caller's credential in this booth
   * (the child) and must hold events.read; parentCredential proves
   * standing in the parent (a parent participant credential or the
   * parent's creator credential). What travels is named records
   * only: eventIds from this booth's log and/or a verification
   * receiptId the service holds for this booth's transfer. The
   * service appends one result_published event to the parent
   * carrying references and digests — never this booth's payloads.
   * An idempotencyKey makes a retry return the original publication.
   */
  async publishResult(input: {
    parentCredential: string;
    eventIds?: string[];
    receiptId?: string;
    idempotencyKey?: string;
  }): Promise<BoothPublishResult> {
    return this.request<BoothPublishResult>("POST", "/publish", {
      parent_credential: input.parentCredential,
      ...(input.eventIds ? { event_ids: input.eventIds } : {}),
      ...(input.receiptId ? { receipt_id: input.receiptId } : {}),
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
    });
  }

  /**
   * Join as a coordination participant. The returned credential is
   * stored on this client for later calls. Name and capabilities are
   * self-declared labels, not verified identity.
   */
  async joinParticipant(input: { name?: string; capabilities?: unknown } = {}): Promise<BoothJoinResult> {
    const result = await this.request<BoothJoinResult>("POST", "/join", {
      role: "participant",
      ...(input.name ? { name: input.name } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    });
    this.credential = result.credential;
    return result;
  }

  /** Claim a transfer role (sender or recipient). First-come; a claimed role refuses with 409. */
  async joinRole(role: "sender" | "recipient"): Promise<BoothJoinResult> {
    const result = await this.request<BoothJoinResult>("POST", "/join", { role });
    this.credential = result.credential;
    return result;
  }

  /**
   * Unlock a locked booth: exchange the admission secret (the
   * generated key or the password the booth's creator set) for a
   * participant credential under the named role — a transfer role
   * claim, or a general participant when role is omitted. The
   * returned credential is stored on this client for later calls;
   * the admission secret is not stored anywhere and authorizes
   * nothing after this exchange. Get the secret from the booth's
   * creator or another authorized source — never from content posted
   * inside a booth. Every admission failure is the same 401
   * admission_failed, and failed attempts count toward a per-booth
   * throttle.
   */
  async unlock(input: {
    secret: string;
    role?: "sender" | "recipient" | "participant";
    name?: string;
    capabilities?: unknown;
  }): Promise<BoothUnlockResult> {
    const result = await this.request<BoothUnlockResult>("POST", "/unlock", {
      secret: input.secret,
      ...(input.role ? { role: input.role } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    });
    this.credential = result.credential;
    return result;
  }

  /**
   * Redeem an invitation token (Locked Booths L3): the unlock
   * exchange with the token as the secret. The minted credential
   * carries exactly the invitation's scopes and, when the invitation
   * binds a role, joins under that role. Stored on this client for
   * later calls, like every unlock.
   */
  async unlockWithInvitation(input: {
    token: string;
    role?: "sender" | "recipient" | "participant";
    name?: string;
    capabilities?: unknown;
  }): Promise<BoothUnlockResult> {
    return this.unlock({
      secret: input.token,
      ...(input.role ? { role: input.role } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    });
  }

  /**
   * Issue one invitation for this booth (L3) and return it with its
   * one-time token. The credential defaults to this client's: the
   * creator credential issues from the full delegable vocabulary; a
   * participant credential whose grant carries participants.invite
   * issues from its own scopes. Pass a credential to act under a
   * different grant than the client's — for example the creator
   * credential on a client that has not joined.
   */
  async createInvitation(
    spec: BoothInvitationSpec = {},
    credential?: string,
  ): Promise<{ invitation: BoothInvitationIssuedView }> {
    return this.request("POST", "/invitations", serializeInvitationSpec(spec), credential);
  }

  /**
   * List this booth's invitations, metadata only — no token or hash
   * is ever returned. Creator-management grant required: pass the
   * creator credential, or construct the client with it.
   */
  async listInvitations(credential?: string): Promise<{ invitations: BoothInvitationView[] }> {
    return this.request("GET", "/invitations", undefined, credential);
  }

  /** Revoke one invitation, effective immediately. Creator-management grant required. */
  async revokeInvitation(
    invitationId: string,
    credential?: string,
  ): Promise<{ invitation: BoothInvitationView }> {
    return this.request(
      "DELETE",
      `/invitations/${encodeURIComponent(invitationId)}`,
      undefined,
      credential,
    );
  }

  /**
   * Rotate this booth's admission secret (Locked Booths L4). The old
   * secret stops admitting new joins the moment this returns; the
   * new generated key is shown once, in the result. Participants who
   * already joined keep their credentials and access — rotation is
   * about admission, not eviction. Omitting method keeps the booth's
   * current method; a password rotation (or a switch to password)
   * requires the new password, which the service never echoes.
   * Creator-management grant required: pass the creator credential,
   * or construct the client with it.
   */
  async rotateAdmissionSecret(
    input: { method?: "generated_key" | "password"; password?: string } = {},
    credential?: string,
  ): Promise<BoothRotateSecretResult> {
    return this.request("POST", "/rotate-secret", { ...input }, credential);
  }

  /**
   * Protect this booth (Locked Booths L5): lock a booth that was
   * created link-only, applying the create-time admission machinery
   * to it atomically — the verifier and the locked policy land
   * together or not at all. Omitting method mints a generated key,
   * shown once in the result; a password lock requires the password,
   * which the service never echoes. Participants who joined while
   * the booth was link-only keep their credentials and access —
   * locking closes admission behind them, it does not remove them.
   * A booth that is already locked (or invitation-only) refuses.
   * Creator-management grant required: pass the creator credential,
   * or construct the client with it.
   */
  async protectBooth(
    input: { method?: "generated_key" | "password"; password?: string } = {},
    credential?: string,
  ): Promise<BoothProtectResult> {
    return this.request("POST", "/protect", { ...input }, credential);
  }

  /**
   * List this booth's participant grants, metadata only — no
   * credential or hash is ever returned. Creator-management grant
   * required: pass the creator credential, or construct the client
   * with it.
   */
  async listParticipants(credential?: string): Promise<{ participants: BoothParticipantView[] }> {
    return this.request("GET", "/participants", undefined, credential);
  }

  /**
   * Revoke one participant grant (L4), effective on the revoked
   * credential's very next call. The participant's browser sessions
   * and subscription row are revoked in the same step; revoking a
   * transfer-role grant also releases the role claim.
   * Creator-management grant required — participants.revoke is
   * non-delegable, so no participant credential authorizes this.
   */
  async revokeParticipant(
    participantId: string,
    credential?: string,
  ): Promise<{ participant: BoothParticipantView }> {
    return this.request(
      "DELETE",
      `/participants/${encodeURIComponent(participantId)}`,
      undefined,
      credential,
    );
  }

  /**
   * Revoke every live grant one invitation issued (L4) — the
   * distinct companion to revokeInvitation, which stops new
   * redemptions and leaves issued grants standing. Each grant dies
   * exactly as if revoked directly. Creator-management grant
   * required.
   */
  async revokeInvitationGrants(
    invitationId: string,
    credential?: string,
  ): Promise<{
    invitation: BoothInvitationView;
    revoked_count: number;
    participants: BoothParticipantView[];
  }> {
    return this.request(
      "POST",
      `/invitations/${encodeURIComponent(invitationId)}/revoke-grants`,
      {},
      credential,
    );
  }

  /**
   * File an access request against this booth (L4): a bounded note
   * for the booth's creator from a caller who cannot unlock it. No
   * credential is sent — the filer is precisely a caller without
   * one — and the request grants nothing and admits no one. The
   * creator acts on it, if at all, by issuing an invitation.
   */
  async requestAccess(input: {
    label?: string;
    message?: string;
    role?: "sender" | "recipient" | "participant";
  } = {}): Promise<{ access_request: BoothAccessRequestView; note: string }> {
    // The empty-string override suppresses the client's credential:
    // an access request is filed by a caller who has none.
    return this.request("POST", "/access-requests", { ...input }, "");
  }

  /**
   * List this booth's access requests in filing order.
   * Creator-management grant required: pass the creator credential,
   * or construct the client with it.
   */
  async listAccessRequests(
    credential?: string,
  ): Promise<{ access_requests: BoothAccessRequestView[] }> {
    return this.request("GET", "/access-requests", undefined, credential);
  }

  async listEvents(options: { since?: number; type?: string; subject?: string } = {}): Promise<{
    events: BoothEventView[];
    latest_seq: number;
  }> {
    const q = new URLSearchParams();
    if (options.since !== undefined) q.set("since", String(options.since));
    if (options.type) q.set("type", options.type);
    if (options.subject) q.set("subject", options.subject);
    const qs = q.toString();
    return this.request("GET", `/events${qs ? `?${qs}` : ""}`);
  }

  async appendEvent(input: {
    type: string;
    subject: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    inReplyTo?: string;
    relatedIds?: string[];
  }): Promise<{ event: BoothEventView; replayed: boolean }> {
    return this.request("POST", "/events", {
      type: input.type,
      subject: input.subject,
      payload: input.payload,
      ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      ...(input.inReplyTo ? { in_reply_to: input.inReplyTo } : {}),
      ...(input.relatedIds ? { related_ids: input.relatedIds } : {}),
    });
  }

  async getState<T = unknown>(): Promise<T> {
    return this.request<T>("GET", "/state");
  }

  /**
   * Propose a commitment (Living Network Phase 3): a commitment record in
   * the booth log. The named parties endorse it with acceptCommitment —
   * never the proposer; endorsement here means a second credential
   * stood behind the commitment, and "authorized" is reserved for account
   * holders. Fulfillment is computed from the log: every named
   * party endorsed and every checkable condition met.
   */
  async proposeCommitment(
    input: BoothCommitmentProposal,
  ): Promise<{ event: BoothEventView; replayed: boolean }> {
    return this.appendEvent({
      type: "commitment",
      subject: input.subject ?? input.subjects?.[0] ?? "commitment",
      payload: {
        title: input.title,
        ...(input.parties ? { parties: input.parties } : {}),
        ...(input.commitments ? { commitments: input.commitments } : {}),
        ...(input.conditions ? { conditions: input.conditions } : {}),
        ...(input.dueAt ? { due_at: input.dueAt } : {}),
        ...(input.subjects ? { subjects: input.subjects } : {}),
      },
    });
  }

  /**
   * Endorse a commitment. Refused from the commitment's proposer (403
   * commitment_self_accept), mirroring decision acceptance: an
   * endorsement is a second participant standing behind the commitment.
   */
  async acceptCommitment(commitmentEventId: string): Promise<{ event: BoothEventView; replayed: boolean }> {
    return this.appendEvent({
      type: "commitment_accept",
      subject: "commitment",
      payload: { commitment_event_id: commitmentEventId },
    });
  }

  /**
   * Cancel a commitment. Only the commitment's proposer or one of its endorsers
   * may cancel (403 commitment_cancel_forbidden otherwise); a cancelled
   * commitment is terminal.
   */
  async cancelCommitment(commitmentEventId: string): Promise<{ event: BoothEventView; replayed: boolean }> {
    return this.appendEvent({
      type: "commitment_cancel",
      subject: "commitment",
      payload: { commitment_event_id: commitmentEventId },
    });
  }

  /** The booth's commitments with their computed statuses, from the state document. */
  async listCommitments(): Promise<BoothCommitmentView[]> {
    const state = await this.getState<{ commitments: BoothCommitmentView[] }>();
    return state.commitments;
  }

  /**
   * Declare a check (Living Network Phase 5): a set of typed
   * assertions the service evaluates against the booth's log. The
   * declaration is an ordinary log event; the result is computed
   * on read by getCheck / listChecks and is never stored, so the
   * same declaration re-evaluates as evidence lands. The service
   * never runs package code — assertions are data, evaluated by
   * the service's deterministic evaluator.
   */
  async declareCheck(
    input: BoothCheckSpec,
  ): Promise<{ event: BoothEventView; replayed: boolean }> {
    return this.appendEvent({
      type: "check",
      subject: input.subject ?? "check",
      payload: {
        title: input.title,
        ...(input.target ? { target: input.target } : {}),
        ...(input.assertions ? { assertions: input.assertions } : {}),
      },
    });
  }

  /** The booth's checks with their computed results. */
  async listChecks(): Promise<BoothCheckView[]> {
    const result = await this.request<{ checks: BoothCheckView[] }>("GET", "/checks");
    return result.checks;
  }

  /** One check's computed result, by the check event's id. */
  async getCheck(checkEventId: string): Promise<BoothCheckView> {
    return this.request<BoothCheckView>(
      "GET",
      `/checks/${encodeURIComponent(checkEventId)}`,
    );
  }

  /**
   * Set or clear the booth's close condition (Phase 3). Pass
   * "commitment_terminal:<commitment event id>" to close the booth when the
   * named commitment reaches a terminal state, "transfer_accepted" or
   * "all_acks" for the standing conditions, or null to clear.
   * Creator-management grant required: pass the creator credential,
   * or construct the client with it.
   */
  async setCloseCondition(
    closeCondition: string | null,
    credential?: string,
  ): Promise<BoothCloseConditionResult> {
    return this.request("POST", "/close-condition", { close_condition: closeCondition }, credential);
  }

  /**
   * The changes feed: events relevant to this participant after the
   * cursor, with reasons. waitSeconds holds the request open for a
   * relevant event (25 seconds at most) and returns early when one
   * lands. Delivery is at-least-once; resume with next_since.
   */
  async getChanges(options: BoothChangesOptions = {}): Promise<BoothChangesView> {
    const q = new URLSearchParams();
    if (options.since !== undefined) q.set("since", String(options.since));
    if (options.until !== undefined) q.set("until", String(options.until));
    if (options.mode) q.set("mode", options.mode);
    if (options.waitSeconds !== undefined) q.set("wait_seconds", String(options.waitSeconds));
    const qs = q.toString();
    return this.request("GET", `/changes${qs ? `?${qs}` : ""}`);
  }

  /**
   * Phase 13: live listening over the durable log — the changes
   * feed as server-sent events. Yields one open frame, one event
   * frame per relevant event as it lands, and a final end frame
   * when the server closes the stream at its set lifetime. Live
   * listening is best-effort with durable catch-up: a dropped
   * stream loses nothing, and reconnecting with the last seq
   * received (options.since) serves everything missed from the
   * log before the stream goes live again. Pass options.signal
   * to stop early; leaving the loop also closes the stream.
   */
  async *streamChanges(options: BoothStreamOptions = {}): AsyncGenerator<BoothStreamFrame> {
    const q = new URLSearchParams();
    if (options.mode) q.set("mode", options.mode);
    const qs = q.toString();
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;
    if (options.since !== undefined) headers["last-event-id"] = String(options.since);
    const res = await this.fetchFn(
      `${this.baseUrl}/api/v1/booths/${encodeURIComponent(this.boothId)}/stream${qs ? `?${qs}` : ""}`,
      {
        method: "GET",
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = (data?.error ?? {}) as { code?: string; message?: string; details?: unknown };
      throw new ActApiError(
        res.status,
        err.code ?? "unknown_error",
        err.message ?? `Request failed with status ${res.status}.`,
        err.details,
      );
    }
    if (!res.body) {
      throw new ActApiError(0, "stream_unavailable", "The stream response carried no body.");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const frame = parseStreamFrame(raw);
          if (frame?.type === "error") {
            throw new ActApiError(0, frame.code, "The booth stream reported an error.");
          }
          if (frame) yield frame;
          if (frame?.type === "end") return;
          cut = buffer.indexOf("\n\n");
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  }

  /** Record that this participant has seen events up to seq. An ack never resolves a conflict. */
  async ack(seq: number): Promise<{ acked_seq: number; latest_seq: number; closed?: boolean }> {
    return this.request("POST", "/ack", { seq });
  }

  /** Replace this participant's subject subscriptions in full. */
  async setSubscriptions(subjects: string[]): Promise<{
    subjects: string[];
    subscription: BoothSubscriptionView;
  }> {
    return this.request("POST", "/subscriptions", { subjects });
  }

  /** Read this participant's durable subscription (subjects, delivery mode, cursors). */
  async getSubscription(): Promise<{ subscription: BoothSubscriptionView }> {
    return this.request("GET", "/subscriptions");
  }

  /** The participant's pending signals: what in this booth needs their attention, and why. */
  async listSignals(): Promise<BoothSignalsView> {
    return this.request("GET", "/signals");
  }

  /** Acknowledge a signal. This records that it was seen; it never changes the underlying condition. */
  async ackSignal(signalKey: string): Promise<{ signal_key: string; state: string; signal: BoothSignalView }> {
    return this.request("POST", `/signals/${encodeURIComponent(signalKey)}/ack`, {});
  }

  /** Dismiss a signal: seen, and no action will be taken on it. */
  async dismissSignal(signalKey: string): Promise<{ signal_key: string; state: string; signal: BoothSignalView }> {
    return this.request("POST", `/signals/${encodeURIComponent(signalKey)}/dismiss`, {});
  }

  /**
   * Declare a watcher: one typed condition on this participant's
   * subscription (Phase 6). When the condition holds against the
   * booth's log it derives as a signal with reason watcher_triggered.
   * Declaring the same condition again returns the existing watcher
   * with created false.
   */
  async createWatcher(condition: BoothWatcherSpec): Promise<{
    watcher: BoothWatcherView;
    created: boolean;
    subscription: BoothSubscriptionView;
  }> {
    return this.request("POST", "/watchers", { condition });
  }

  /** This participant's declared watchers in this booth. */
  async listWatchers(): Promise<BoothWatchersView> {
    return this.request("GET", "/watchers");
  }

  /** Revoke one of this participant's watchers, by its id. */
  async revokeWatcher(watcherId: string): Promise<{
    revoked: string;
    watchers: BoothWatcherView[];
    subscription: BoothSubscriptionView;
  }> {
    return this.request("DELETE", `/watchers/${encodeURIComponent(watcherId)}`);
  }

  /**
   * Phase 10: create a cross-booth subscription into this booth.
   * This client's credential is the caller's credential in this
   * booth (the destination) and must hold subscriptions.manage;
   * sourceCredential proves standing in the source (a source
   * participant holding events.read, or the source's creator
   * credential) and is checked at creation, never stored. The
   * source must be account-owned in v1, and its owner must have set
   * a publication policy for anything to cross. subjects and
   * eventTypes narrow what this subscription receives on top of the
   * policy. An identical active subscription is returned with
   * created false.
   */
  async createCrossSubscription(input: {
    sourceBoothId: string;
    sourceCredential: string;
    subjects?: string[];
    eventTypes?: string[] | null;
  }): Promise<BoothCrossSubscriptionResult> {
    return this.request<BoothCrossSubscriptionResult>("POST", "/cross-subscriptions", {
      source_booth_id: input.sourceBoothId,
      source_credential: input.sourceCredential,
      ...(input.subjects ? { subjects: input.subjects } : {}),
      ...(input.eventTypes !== undefined ? { event_types: input.eventTypes } : {}),
    });
  }

  /** This participant's cross-booth subscriptions into this booth. */
  async listCrossSubscriptions(): Promise<{ subscriptions: BoothCrossSubscriptionView[] }> {
    return this.request("GET", "/cross-subscriptions");
  }

  /**
   * Revoke one of this participant's cross-booth subscriptions, by
   * its id. Revoking stops further forwards from that source into
   * this booth; events already forwarded stay in the log.
   */
  async revokeCrossSubscription(subscriptionId: string): Promise<{
    revoked: string;
    subscription: BoothCrossSubscriptionView;
  }> {
    return this.request("DELETE", `/cross-subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  private briefSuffix(options: BoothBriefOptions, format?: "md"): string {
    const q = new URLSearchParams();
    if (options.participant) q.set("participant", options.participant);
    if (options.subject) q.set("subject", options.subject);
    if (options.role) q.set("role", options.role);
    if (options.dependencyOf) q.set("dependency_of", options.dependencyOf);
    if (options.since !== undefined) q.set("since", String(options.since));
    if (options.maxRecords !== undefined) q.set("max_records", String(options.maxRecords));
    if (options.maxBytes !== undefined) q.set("max_bytes", String(options.maxBytes));
    if (format) q.set("format", format);
    const qs = q.toString();
    return `/brief${qs ? `?${qs}` : ""}`;
  }

  /**
   * The booth Brief (Living Network Phase 4): the state cut to the
   * given filters, as a deterministic projection of the log.
   * Accepted and proposed material sit in separate sections, every
   * entry carries its source event id, and omitted counts what the
   * filters and limits cut, with the reason. Nothing is stored and
   * nothing is reworded.
   */
  async getBrief(options: BoothBriefOptions = {}): Promise<BoothBriefView> {
    return this.request("GET", this.briefSuffix(options));
  }

  /** The same Brief rendered as Markdown (the server's format=md form). */
  async getBriefMarkdown(options: BoothBriefOptions = {}): Promise<string> {
    const credential = this.credential;
    const res = await this.fetchFn(
      `${this.baseUrl}/api/v1/booths/${encodeURIComponent(this.boothId)}${this.briefSuffix(options, "md")}`,
      {
        method: "GET",
        headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      },
    );
    const text = await res.text();
    if (!res.ok) {
      let code = "unknown_error";
      let message = `Request failed with status ${res.status}.`;
      try {
        const data = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = data.error?.code ?? code;
        message = data.error?.message ?? message;
      } catch {
        // The error body was not JSON; keep the status-based message.
      }
      throw new ActApiError(res.status, code, message);
    }
    return text;
  }

  /**
   * The booth Replay (Living Network Phase 4): the state as of a
   * sequence number, plus the event slice. With a participant, also
   * the changes that reached them by then; their ack cursor is
   * labeled as a current value, not as-of, and the response carries
   * its causation note — sequence order is never causation.
   */
  async getReplay(options: BoothReplayOptions = {}): Promise<BoothReplayView> {
    const q = new URLSearchParams();
    if (options.untilSeq !== undefined) q.set("until_seq", String(options.untilSeq));
    if (options.subject) q.set("subject", options.subject);
    if (options.participant) q.set("participant", options.participant);
    const qs = q.toString();
    return this.request("GET", `/replay${qs ? `?${qs}` : ""}`);
  }

  /**
   * Ask the Booth (Living Network Phase 4): an exact-subject lookup
   * over the log with citations on every record. q is a substring
   * match over subjects and summary fields — the response labels it
   * as substring matching, not semantic search. At least one of
   * subject, type, or q is required.
   */
  async ask(options: BoothAskOptions = {}): Promise<BoothAskView> {
    const q = new URLSearchParams();
    if (options.subject) q.set("subject", options.subject);
    if (options.type) q.set("type", options.type);
    if (options.q) q.set("q", options.q);
    const qs = q.toString();
    return this.request("GET", `/ask${qs ? `?${qs}` : ""}`);
  }

  /**
   * The booth What-If evaluation (Living Network Phase 11):
   * validate the hypothetical event inputs with the append path's
   * own validation, append them in memory to a copy of the log
   * (truncated at atSeq when given), and return the delta — new
   * conflicts, competing contracts, stale assumptions, affected
   * participants, commitment and check status changes — every entry
   * labeled hypothetical with its base seq. Nothing is written:
   * the booth's log and state are unchanged, and making any of it
   * real means posting the events. The impact graph covers
   * declared dependencies and subject links only; the evaluation
   * cannot see anything the log does not declare.
   */
  async evaluateWhatIf(input: {
    events: BoothWhatIfEventInput[];
    atSeq?: number;
  }): Promise<BoothWhatIfView> {
    return this.request<BoothWhatIfView>("POST", "/whatif", {
      events: input.events,
      ...(input.atSeq !== undefined ? { at_seq: input.atSeq } : {}),
    });
  }

  private capsuleBody(input: {
    selection?: BoothCapsuleSelection;
    preset?: "temporary_org";
    expectedDigest?: string;
  }): Record<string, unknown> {
    return {
      ...(input.selection
        ? {
            selection: {
              ...(input.selection.eventIds ? { event_ids: input.selection.eventIds } : {}),
              ...(input.selection.subjects ? { subjects: input.selection.subjects } : {}),
              ...(input.selection.sections ? { sections: input.selection.sections } : {}),
            },
          }
        : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      ...(input.expectedDigest ? { expected_digest: input.expectedDigest } : {}),
    };
  }

  /**
   * The capsule selection preview (Living Network Phase 12): the
   * sensitive-content review step. Returns exactly what the
   * selection would include — the manifest entries, the Markdown
   * summary, and the digest the capsule would carry — and stores
   * nothing. Creation requires the same selection echoed back.
   */
  async previewCapsule(input: {
    selection?: BoothCapsuleSelection;
    preset?: "temporary_org";
  }): Promise<BoothCapsulePreview> {
    return this.request<BoothCapsulePreview>("POST", "/capsules/preview", this.capsuleBody(input));
  }

  /**
   * Create a capsule from the echoed selection (Living Network
   * Phase 12): a manifest built from the log, a Markdown summary
   * rendered from the same data, and the full selected records,
   * stored as one artifact. Pin expectedDigest to a preview's
   * digest and creation refuses (409 capsule_drift) when the log
   * has moved since the preview. The temporary_org preset exports
   * a temporary agent organization: the booth's full working
   * record plus an organization block (objective, roster,
   * completion check ids).
   */
  async createCapsule(input: {
    selection?: BoothCapsuleSelection;
    preset?: "temporary_org";
    expectedDigest?: string;
  }): Promise<BoothCapsuleView> {
    const result = await this.request<{ capsule: BoothCapsuleView }>(
      "POST",
      "/capsules",
      this.capsuleBody(input),
    );
    return result.capsule;
  }

  /** One capsule created from this booth, with its summary. */
  async getCapsule(capsuleId: string): Promise<BoothCapsuleView> {
    const result = await this.request<{ capsule: BoothCapsuleView }>(
      "GET",
      `/capsules/${encodeURIComponent(capsuleId)}`,
    );
    return result.capsule;
  }

  /** The capsules created from this booth, newest first (ids, digests, counts). */
  async listCapsules(): Promise<
    Array<{
      id: string;
      digest: string;
      created_at: string;
      preset: "temporary_org" | null;
      counts: { events: number; by_type: Record<string, number> };
    }>
  > {
    const result = await this.request<{ capsules: Array<{ id: string; digest: string; created_at: string; preset: "temporary_org" | null; counts: { events: number; by_type: Record<string, number> } }> }>(
      "GET",
      "/capsules",
    );
    return result.capsules;
  }

  /**
   * Import a capsule into this booth (Living Network Phase 12).
   * This client is the TARGET booth; the caller's credential here
   * is the only one involved — a capsule grants no access to its
   * source booth and no source credential takes part. Records
   * land as new proposals authored by the caller, each carrying
   * provenance { capsule_id, origin_booth_id, origin_event_id }:
   * accepted decisions arrive proposed, contracts arrive as new
   * versions authored by the caller, and endorsement acts and
   * service-authored records do not cross (the result lists every
   * skip with its reason). Importing the same capsule into the
   * same booth twice replays instead of duplicating.
   */
  async importCapsule(capsuleId: string): Promise<BoothCapsuleImportResult> {
    return this.request<BoothCapsuleImportResult>(
      "POST",
      `/capsules/${encodeURIComponent(capsuleId)}/import`,
      {},
    );
  }

  /**
   * Export a skill from a capsule of this booth (Living Network
   * Phase 12, §20): package a capability the capsule names (a
   * capability_offer event's version — picked by eventId or
   * versionId, or the capsule's only offered version) again
   * through the standard createCapability path, under the
   * exporter's booth identity or an ephemeral booth user, with a
   * provenance.json file added to the package naming the capsule,
   * the origin booth and event, the origin version and digest,
   * and the verification receipt ids the log holds for the
   * capability.
   */
  async exportCapsuleSkill(
    capsuleId: string,
    input: { eventId?: string; versionId?: string } = {},
  ): Promise<BoothCapsuleSkillExport> {
    return this.request<BoothCapsuleSkillExport>(
      "POST",
      `/capsules/${encodeURIComponent(capsuleId)}/skill-export`,
      {
        ...(input.eventId ? { event_id: input.eventId } : {}),
        ...(input.versionId ? { version_id: input.versionId } : {}),
      },
    );
  }
}
