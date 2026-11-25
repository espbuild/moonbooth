# Architecture

Moonbooth has three layers. The package-format library stands alone; the
hosted service is one way to move packages; the verification subsystem is
shared by both local and hosted checks.

## Package format library (`packages/protocol`)

Pure TypeScript, no I/O beyond reading package bytes it is given.
Provides: the manifest JSON Schema and validator, the package builder
and reader, canonical digests, and the transfer state machine. Any tool
can build and validate a capability package (ACT 0.1 format) without the
hosted service.

## Security library (`packages/security`)

Pure functions over package contents: secret pattern scanning, file
policy enforcement, and instruction-risk heuristics. Results are
structured findings with levels (block, warn, info). A scan never
returns "safe"; it returns the findings it produced and the checks it
ran.

## Verification library (`packages/verification`)

Structural checks, security policy checks, compatibility assessment
against a declared environment, and a deterministic behavioral harness
that runs paired baseline and with-capability trials against fixed
fixtures and scores them against explicit criteria. Produces receipt
objects that bind results to a package digest and a test suite version.

## Hosted service (`apps/web`)

Next.js application with a REST API under `/api/v1`.

- **Accounts**: email and password, argon2id hashing, hashed session
  tokens, httpOnly cookies, double-submit CSRF tokens.
- **Data**: Drizzle ORM over Postgres. Production uses `DATABASE_URL`.
  Development and tests use an embedded Postgres (PGlite) with the same
  schema and migrations. See DECISIONS.md for the reasoning and limits.
- **Artifacts**: an object storage interface. Local filesystem for
  development and tests; S3-compatible storage in production.
- **Jobs**: a database-backed job table processed by a worker loop in
  the web process. Package scanning and verification runs are jobs.
- **Audit**: lifecycle and security events are recorded in an audit
  table without package contents or invitation tokens.

## Transports

The hosted service is one transport. The same package can move as a
file, at an agent-readable URL, or through the MCP tools. Transfer
semantics (offer, approve, verify, accept) live in the protocol layer,
not in the transport.
