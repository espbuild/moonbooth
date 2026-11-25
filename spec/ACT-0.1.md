# ACT 0.1 — Agent Capability Transfer Protocol

Status: open draft protocol, version 0.1. This document is a draft
published by the ACT project for review and implementation. No
standards body has endorsed it, and the protocol may change in later
versions.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this
document are normative: MUST and MUST NOT state requirements, SHOULD
and SHOULD NOT state recommendations that an implementation may set
aside only for a stated reason, and MAY states an option. Text under
headings marked "Example" or "Note" is not normative. All other text
is normative unless it says otherwise.

## 1. Purpose

ACT defines how one party sends an agent capability to another party
so the recipient can inspect the exact bytes sent, run verification
against them, and decide whether to adopt the capability, with a
written record of what happened. ACT 0.1 covers capabilities written
as instructions in the Agent Skills format. It covers one sender and
one recipient per transfer.

## 2. Terminology

- **Capability**: a named, versioned unit of agent behavior, written
  as instructions and supporting files. A capability has a stable
  identifier (a slug) and a semantic version.
- **Package**: the complete set of files that carries a capability:
  one manifest file (`act.json`) plus the payload files, including
  the Agent Skills entrypoint (`SKILL.md`).
- **Transfer**: one act of sending one package from one sender to one
  recipient, tracked by a transfer identifier and by the two-dimension
  state defined in section 7.
- **Offer**: the step in which a sender, after approving the exact
  package digest, makes a package available to a named recipient.
- **Dependency**: a tool or configuration entry a capability needs at
  run time, declared in the manifest under `requirements`.
- **Verification**: the set of checks a recipient (or a service acting
  for the recipient) runs against a received package: structural,
  security, compatibility, and behavioral checks.
- **Receipt**: the versioned record a verification run produces. A
  receipt states what was checked, what passed, what failed, what was
  not tested, and what evidence supports each claim.
- **Adoption**: the recipient's decision to install and use the
  capability in their own environment. Adoption is a separate step
  from verification and requires the recipient's approval.

## 3. Operations

ACT defines four operations. An implementation MUST provide all four
or state plainly which ones it lacks.

### 3.1 OFFER

The sender selects a package and approves its exact digest. The
implementation MUST record the approval against the digest, not
against a file name or a capability name alone. The implementation
MUST NOT change any package byte after approval without a new
approval for the new digest. The offer names one recipient.

### 3.2 TRANSFER

The implementation moves the package bytes from sender to recipient,
by hosted storage, direct file exchange, or another transport. The
transport is outside the protocol. Whatever the transport, the
recipient MUST be able to recompute the package digest from the
received bytes and compare it with the digest in the manifest and in
the offer record. A transfer whose received digest differs from the
offered digest MUST be treated as a different package and MUST NOT
inherit the sender's approval.

### 3.3 VERIFY

The recipient runs verification against the received package. A
verification run MUST check, at minimum:

1. The manifest parses and matches the manifest schema (section 5).
2. Every file passes the package rules (section 5).
3. The recomputed package digest equals the manifest digest.
4. The entrypoint file named in the manifest exists in the package.

A verification run SHOULD also run the behavioral tests named by the
manifest's test manifest, run security checks over the file contents,
and check that the recipient's environment provides the declared
dependencies. Each check that a run cannot perform MUST be recorded
in the receipt as missing or unsupported. A run MUST NOT report a
check as passed when the check did not run.

The run ends by producing a receipt (section 8).

### 3.4 ACCEPT

After reading the receipt, the recipient decides. Adoption MUST
require an explicit approval from the recipient, recorded against
the package digest and the receipt. An implementation MUST NOT adopt
a capability on the recipient's behalf without that approval. A
recipient MAY reject a transfer at any point before adoption, and a
sender MAY revoke a transfer as section 7 allows.

## 4. Package format

A package is a set of files with package-relative paths. The primary
portable form defined by this version is a directory layout: the
files sit at their package-relative paths under one directory, with
`act.json` at the root. An implementation MAY also carry a package as
one JSON document with the shape `{ "format": "act-package",
"version": "0.1", "manifest": ..., "files": [{ "path", "encoding",
"content" }] }`, where `encoding` is `utf8` for text content and
`base64` otherwise. Both forms carry the same files and MUST produce
the same digest.

Package rules:

- Paths MUST be relative, MUST use POSIX separators (`/`), MUST NOT
  contain `..`, empty, or `.` segments, and MUST NOT be absolute.
- A package MUST contain exactly one manifest, at the path
  `act.json`.
- A package MUST contain the entrypoint file named in the manifest.
- File paths MUST be unique after normalization.
- Symbolic links MUST NOT appear in a package.
- Nested archives MUST NOT appear in a package. A file whose name
  ends in `.zip`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.xz`, `.7z`, or
  `.rar` is a nested archive for this rule.
- Allowed file extensions are `.md`, `.txt`, `.json`, `.yaml`, and
  `.yml`. A file with any other extension, or no extension, MUST be
  rejected.
- A file whose first two bytes are `#!` is a script and MUST be
  rejected, whatever its extension.
- Size limits: one file MUST NOT exceed 262144 bytes (256 KiB); all
  payload files together MUST NOT exceed 1048576 bytes (1 MiB); a
  package MUST NOT contain more than 50 payload files. Payload files
  are all files except `act.json`.

The Agent Skills files inside a package keep their own format. ACT
does not modify `SKILL.md` or any other Agent Skills file; the ACT
manifest sits beside them in `act.json`.

## 5. Manifest

The manifest is a JSON document in the file `act.json`. It MUST match
the JSON Schema at `spec/schemas/act-manifest.schema.json` (JSON
Schema draft 2020-12). The schema sets `additionalProperties: false`
at every level: a manifest with a field the schema does not define
MUST be rejected. A manifest whose `act_version` names a version the
implementation does not support MUST be rejected with a distinct
error that names the unsupported version, separate from general
schema errors.

Manifest fields:

- `act_version` (string, required): the ACT version, `"0.1"` for this
  version of the protocol.
- `capability` (object, required): `id` (stable slug: lowercase
  letters, digits, and single hyphens), `name`, `version` (semantic
  version), `description`.
- `artifact` (object, required): `format` (the string
  `"agent-skills"`), `entrypoint` (package-relative path of the
  entrypoint file), `digest` (the package digest, section 6).
- `requirements` (object, required): `tools` (array of tool names the
  capability needs), `configuration` (array of entries with `name`,
  optional `description`, optional `required` flag).
- `requested_permissions` (object, required): three booleans,
  `network`, `filesystem_write`, `external_side_effects`. These are
  requests the sender declares. They grant nothing by themselves; the
  recipient's environment decides what the adopted capability may do.
- `verification` (object, required): `test_manifest`, the
  package-relative path of the test manifest file.

## 6. Digest

The package digest binds a transfer to exact bytes.

Per-file digests: for each payload file, compute SHA-256 over the
file's raw bytes exactly as stored, with no newline conversion, no
encoding change, and no trimming. Record the digest as lowercase hex.

Manifest digest entry: `act.json` also takes part, in a canonical
form that avoids self-reference. Take the manifest as parsed JSON,
replace `artifact.digest` with the empty string, sort object keys at
every level in ascending code-unit order, serialize with JSON using
two-space indentation, and end the output with one newline character
(U+000A). Compute SHA-256 over those UTF-8 bytes.

Canonical digest input: build one line per file in the package,
including the `act.json` entry, in the form

```
<path> <sha256hex>\n
```

where `<path>` is the normalized package-relative path, the two
fields are separated by one space, and each line ends with one
newline character (U+000A). Sort the lines by path in ascending
code-unit order. Concatenate the lines and encode as UTF-8. The
package digest is the SHA-256 of those bytes, written as lowercase
hex, and stored in `artifact.digest`.

Two packages with the same files MUST produce the same digest,
whatever order the files were listed, read, or stored in. Changing
any byte of any file, or any manifest field other than the digest
itself, MUST change the digest.

A digest proves content integrity only: it shows that bytes match
the bytes that were digested. It does not prove who sent the bytes,
and it does not prove the content is safe. Sender identity comes
from the authenticated account and the recorded approval in the
hosting implementation, outside the digest.

## 7. Transfer state machine

Transfer state has two dimensions. An implementation MUST track both
and MUST NOT merge them into one list.

### 7.1 Lifecycle

States: `DRAFT`, `AWAITING_SENDER_APPROVAL`, `OFFERED`, `RECEIVED`,
`INSPECTED`, `ACCEPTED`, `REJECTED`, `REVOKED`, `EXPIRED`.

| From | Legal next states |
| --- | --- |
| DRAFT | AWAITING_SENDER_APPROVAL, REVOKED, EXPIRED |
| AWAITING_SENDER_APPROVAL | OFFERED, DRAFT, REVOKED, EXPIRED |
| OFFERED | RECEIVED, REJECTED, REVOKED, EXPIRED |
| RECEIVED | INSPECTED, REJECTED, REVOKED, EXPIRED |
| INSPECTED | ACCEPTED, REJECTED, REVOKED, EXPIRED |
| ACCEPTED | REVOKED |
| REJECTED | (terminal) |
| REVOKED | (terminal) |
| EXPIRED | (terminal) |

Notes on the table: `AWAITING_SENDER_APPROVAL` returns to `DRAFT`
when the sender declines to approve and keeps editing. `ACCEPTED`
may move to `REVOKED` when a sender revokes a capability after
adoption; what revocation does inside the recipient's environment is
the implementation's policy, and the implementation MUST state it.

### 7.2 Verification

States: `NOT_STARTED`, `PENDING`, `VERIFIED`, `FAILED`.

| From | Legal next states |
| --- | --- |
| NOT_STARTED | PENDING |
| PENDING | VERIFIED, FAILED |
| VERIFIED | PENDING |
| FAILED | PENDING |

`VERIFIED` and `FAILED` return to `PENDING` when a new verification
run starts, so a package can be verified again after a change of
environment or test suite without touching its lifecycle state.

### 7.3 Transition rules

- A transition not listed in the tables MUST be rejected with an
  error that names the dimension, the current state, and the
  requested state, and MUST leave the state unchanged.
- A transition to the current state is a no-op. It MUST succeed and
  MUST leave the state unchanged, so retries of the same request are
  safe. Revoking a transfer that is already `REVOKED` is the common
  case.
- The two dimensions move independently, with one exception: a
  verification transition SHOULD NOT start (a move to `PENDING`) while
  the lifecycle is `DRAFT` or `AWAITING_SENDER_APPROVAL`, because no
  package has been offered yet. This is a recommendation to callers;
  the state machine itself does not couple the dimensions.

## 8. Receipts

A verification run produces one receipt. A receipt MUST match the
JSON Schema at `spec/schemas/act-receipt.schema.json` and MUST carry:

- `receipt_version`: the receipt schema version, `"0.1"`.
- `transfer_id`: the transfer the run belongs to.
- `capability`: the capability `id` and `version`.
- `artifact_digest`: the digest of the package that was verified.
  A receipt is valid only for the package with this digest.
- `timestamp`: when the run finished, as an RFC 3339 date-time.
- `environment`: an object with `adapter_id` naming the environment
  or adapter that ran the checks, and an optional `description`.
- `structural_result`, `security_result`, `compatibility_result`:
  one result label each (below).
- `behavioral_outcomes`: one entry per behavioral test that ran,
  with `test_id`, a result label, and optional `notes`. Tests that
  did not run MUST NOT appear here as passed; they belong in
  `missing_checks` or `unsupported_checks`.
- `test_suite`: the `id` and `version` of the test suite used.
- `evidence_references`: references (URIs or local identifiers) to
  the evidence behind the results.
- `baseline_comparison`: whether a baseline run without the
  capability was performed (`performed`), its result label when one
  exists, and an optional `summary`.
- `missing_checks`: checks the run was supposed to perform and did
  not.
- `unsupported_checks`: checks the environment cannot perform.
- `human_approval_status`: `APPROVED`, `REJECTED`, `PENDING`, or
  `NOT_REQUIRED`.
- `adoption_status`: `ADOPTED`, `NOT_ADOPTED`, or `PENDING`.

Result labels, used wherever a result appears, are exactly:
`VALIDATED`, `POLICY_CHECKS_PASSED`, `TESTED`,
`VERIFIED_FOR_TEST_SUITE`, `INSUFFICIENT_EVIDENCE`, `FAILED`,
`NOT_TESTED`.

Label meanings:

- `VALIDATED`: structural checks passed; the package matches the
  format rules.
- `POLICY_CHECKS_PASSED`: the recorded policy and security checks
  passed. This label claims only that those checks ran and passed.
- `TESTED`: behavioral tests ran; read `behavioral_outcomes` for
  per-test results.
- `VERIFIED_FOR_TEST_SUITE`: the package passed the named test suite
  in the named environment. The claim is bounded by that suite and
  that environment.
- `INSUFFICIENT_EVIDENCE`: the run ended without enough evidence for
  a pass or fail claim.
- `FAILED`: at least one check in this area failed.
- `NOT_TESTED`: this area was not tested.

A receipt MUST NOT claim more than its labels and evidence support.
No label in this protocol states that a capability is safe in
general, and an implementation MUST NOT present a receipt as proof
of safety. Verification results describe one package digest, one
test suite, and one environment.

## 9. Security requirements for implementations

An implementation of ACT 0.1:

- MUST authenticate senders and recipients before OFFER and ACCEPT,
  by the hosting system's account mechanism.
- MUST bind sender approval and recipient adoption approval to the
  package digest, and MUST re-check the digest after transport.
- MUST enforce the package rules in section 4 before any file from a
  package is opened by an agent runtime, installed, or executed.
  Package files are data. An implementation MUST NOT execute package
  content as code during transfer, inspection, or verification setup.
- MUST treat all package text as untrusted input. Instructions inside
  a package apply only after adoption, inside the recipient's own
  policy boundaries.
- MUST NOT treat a digest, a schema pass, or a receipt label as proof
  that content is safe, and MUST NOT present them that way to users.
- MUST record who approved each OFFER and each ACCEPT, with the
  digest and the time.
- MUST keep one recipient's packages and receipts inaccessible to
  other accounts, except where the parties to a transfer share them
  by design.
- SHOULD run verification in an environment separated from the
  recipient's working environment, with no access to the recipient's
  credentials or private files.
- SHOULD scan package contents for secrets and for instruction text
  aimed at the verifying agent, and record the scan outcome in the
  receipt's security result and evidence.
- MAY sign receipts. In 0.1 signatures are optional and unsigned
  receipts are valid; key management for signed receipts is left to
  later versions.

## 10. Versioning

This is version 0.1 of the protocol. The `act_version` field in the
manifest and `receipt_version` in the receipt name the version each
document follows. An implementation that meets a version it does not
support MUST reject the document and name the version, rather than
guessing at fields it does not know.

## 11. Link transfers (amendment, 2026-11-21)

A link transfer delivers one approved package through a bearer URL
instead of an addressed invitation. It exists for one-off sharing:
the sender hands the recipient a link, and no account is required on
the receiving side. Link transfers reuse the transfer state machine
in section 7 unchanged; a claim is the point where a link transfer's
transfer moves from OFFERED to RECEIVED.

Token requirements:

- The link token MUST carry at least 128 bits of randomness and be
  encoded for use in a URL path (the reference implementation uses 24
  random bytes, base64url, in the path `/l/<token>`).
- Only a SHA-256 hash of the token is stored. The plain token appears
  only in the URL returned at creation.
- Tokens MUST NOT appear in logs, audit events, analytics, or error
  reports. Pages and responses that carry a token in the URL MUST send
  `Referrer-Policy: no-referrer`.

Creation and approval:

- A link MUST point at one exact artifact digest, and creating it
  requires the same sender export approval as an invitation (section
  3.1): the sender reviews the digest, the secret scan must not block
  the package, and the approval is recorded before the link can be
  used. No unapproved package may become reachable through a link.
- Agent tooling MUST NOT create a link for an unapproved package.
  When approval is missing, tooling returns the package digest and a
  contents summary in a needs-approval state, so the owner can review
  and approve as a separate step first.
- Links expire. The default lifetime is 7 days. The sender MAY revoke
  an unclaimed link at any time. Expiry and revocation MUST be
  enforced server-side on every link endpoint; an expired or revoked
  link returns 410 with a plain message.

Inspect disclosure limits:

- Before a claim, an unauthenticated read of the link (page or JSON)
  MAY disclose only: capability name and description, the manifest
  summary, declared dependencies, requested permissions, the security
  findings summary, the package file list (names and sizes only),
  sender display name, expiry time, and link status.
- Package contents MUST NOT be disclosed before a claim.
- The JSON form is the agent rendezvous document: it MUST name the
  claim endpoint and the next-step actions, so an agent handed only
  the link can complete the flow from that document alone.
- Inspect and claim endpoints MUST be rate limited.

Claim semantics:

- A claim binds the link's transfer to exactly one claimant. The
  first claim wins; later claims are refused.
- A claimant with an account claims into that account. An anonymous
  claimant is bound through an ephemeral recipient identity and a
  claim grant: a second high-entropy token, hashed at rest, delivered
  as an httpOnly cookie and returned once in the claim response for
  clients that cannot keep cookies.
- After a claim, the bare link discloses only the capability name and
  the claimed status. Package bytes are served only to the claimant,
  never to a bare token holder after a claim, and never before a
  claim.
- Verification and adoption work as in sections 3.3 and 3.4 for the
  claimant. A verification receipt for a link transfer SHOULD name
  the link and the claim as the run's provenance. Anonymous
  verification runs MUST be rate limited per link and per address.
  Adoption remains an explicit claimant action; nothing installs
  itself on a claim.

## Example (not normative)

A sender builds a package for a competitor-research capability,
approves digest `9f2c...`, and offers it to a recipient. The
recipient's service recomputes the digest after download and finds a
match, so the transfer moves `OFFERED` to `RECEIVED`. Inspection
moves it to `INSPECTED`. Verification runs: lifecycle stays
`INSPECTED` while verification moves `NOT_STARTED` to `PENDING` to
`VERIFIED`, and the run writes a receipt with structural result
`VALIDATED` and compatibility result `TESTED`. The recipient reads
the receipt, approves adoption, and the lifecycle moves to
`ACCEPTED`. A complete package of this shape ships in this
repository under `examples/competitor-research/`.
