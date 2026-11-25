# Security policy and controls

This document lists the controls implemented in the hosted service and
the libraries. The threat model (threat-model.md) explains the
reasoning. Controls are listed only when implemented and tested; the
implementation checklist tracks their state.

- Authentication: argon2id password hashing, per-account rate limits,
  generic credential errors, dummy-hash verification for unknown emails.
- Sessions: 32-byte random tokens, SHA-256 hashed at rest, httpOnly
  SameSite=Lax cookies, 30-day expiry, server-side revocation on sign
  out.
- CSRF: double-submit token on every mutating API request.
- Authorization: every transfer, package, verification, and receipt
  read checks the caller's relationship to the object (sender,
  addressed recipient, or run owner). Cross-account reads return 404.
- Invitations: 32-byte random tokens, SHA-256 hashed at rest, expiry,
  revocation, single-recipient binding by account email.
- Share links: 24-byte random tokens (192 bits), SHA-256 hashed at
  rest, 7-day default expiry, sender revocation, one claim only.
  Inspect discloses metadata only (no package contents) and is rate
  limited per address and token; claims are rate limited per address.
  After a claim the bare link discloses only the capability name and
  the claimed status. Anonymous claims bind to an ephemeral recipient
  identity through a claim grant (32-byte token, SHA-256 hashed at
  rest, shown once). Verification runs by ephemeral claimants are rate
  limited per transfer and per address. Link tokens never appear in
  logs, audit events, or analytics.
- Uploads: package validation before storage; allowlisted file types;
  size and count limits; digest computed server-side and compared with
  the approved digest before any recipient access.
- Logging: structured audit events with ids and digests only. Package
  contents and invitation tokens are never logged.
- Headers: Next.js defaults plus a restrictive referrer policy on
  invitation pages so tokens do not leak through outbound links.
  Share link pages and link API responses send Referrer-Policy:
  no-referrer and Cache-Control: no-store.

Reporting: open an issue in this repository marked "security" for
non-sensitive reports. For sensitive reports, contact the repository
owner through GitHub.
