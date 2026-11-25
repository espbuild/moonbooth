# Threat model

Moonbooth moves instructional content between agents owned by
different people. The package is the attack surface. This document
states what Moonbooth defends against, how, and what it does not claim.

## Assets

- The recipient's agent environment: its tools, files, memory, and
  authority to act for the recipient.
- The sender's private material: credentials, conversations, memory,
  and system instructions that must never leave in a package.
- The integrity of the transfer record: approvals, digests, receipts.

## Adversaries

- A malicious sender crafting a package that harms or manipulates the
  recipient's agent.
- A careless sender exporting material that contains secrets.
- A third party who obtains an invitation link.
- A malicious recipient probing for other users' packages or transfers.
- A compromised or curious service operator is out of scope for v0.1
  beyond standard access control and audit logging; packages are not
  end-to-end encrypted in v0.1, and the product copy says so.

## Defenses, by side

### Sender side

- Export starts only from content the sender explicitly selects.
- The packaging flow never reads agent memory, conversation history,
  environment files, or hidden prompts on its own.
- Outbound content is scanned for common credential and secret
  patterns, including high-entropy strings. A likely credential blocks
  export until the sender removes it and validation runs again.
- The sender reviews the complete package and approves a specific
  package digest. Changing any file after approval changes the digest
  and invalidates the approval.

### Package format

- Allowlisted, inspectable file types only: Markdown, plain text,
  JSON, YAML. Scripts, binaries, symlinks, nested archives, and path
  traversal entries are rejected.
- Size and file-count limits are enforced at build and at ingest.
- The manifest is validated against a strict JSON Schema. Unknown
  fields are rejected so metadata cannot smuggle instructions past
  review.

### Recipient side

- A package is untrusted data. Its text is never concatenated into
  trusted system instructions by Moonbooth components.
- Inspection renders Markdown safely (no raw HTML execution).
- Verification runs use synthetic inputs and fixed fixtures, a fixed
  tool set, no real credentials, no open network, and resource limits.
- Adoption is an explicit recipient action. Nothing installs, schedules,
  or persists automatically.

### Hosted service

- Server-side authorization on every object: a transfer is visible
  only to its sender and its addressed recipient.
- Invitations are high-entropy tokens, stored as hashes, expiring, and
  revocable. Revocation blocks future hosted access; it cannot recall
  downloaded copies, and the UI states this.
- Session tokens are stored hashed. CSRF protection on mutating
  requests. Rate limits on authentication and invitation redemption.
- Audit events record lifecycle transitions without package contents.

## Known limitations

- Secret scanning is pattern-based. It catches common formats and
  high-entropy strings; it cannot catch every secret, and the product
  says so at the point of export.
- Behavioral verification tests the tasks in its suite. Passing means
  the capability performed on those tasks in that environment, nothing
  more.
- A determined sender can encode harmful instructions in plain
  language that no scanner flags. Human review of the full package
  before adoption is a designed step, not a formality.
- Receipts in v0.1 are authenticated service records, not cryptographic
  attestations. Their digest binds them to the tested artifact; their
  authenticity rests on the service's access control and audit log.
