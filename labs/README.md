# Moonbooth Labs — experiment harness

A config-driven harness for running controlled multi-agent experiments
and recording what actually happened. A scenario names an objective, a
set of equivalent task variants, independent agent sessions (roles), and
the coordination condition under test; the harness runs every variant
under every condition in counterbalanced order, captures outcomes
against the scenario's own checks, and writes an immutable run manifest
plus a sanitized export for each run.

The harness is a measuring instrument, not an orchestrator: it never
solves the task, never coordinates the agents itself, and never assumes
Moonbooth. Moonbooth is one condition among three.

## Conditions

- **files** — agents coordinate through an ordinary shared directory.
- **git** — agents coordinate through a shared git repository (each
  role publishes with commit + push from its own clone).
- **moonbooth** — agents coordinate through a booth on the Moonbooth
  service, via this repository's own `@moonbooth/sdk`, against a
  configurable API base URL (scenario `moonbooth.apiBaseUrl`, default
  `https://www.moonbooth.ai`; the `MOONBOOTH_LABS_API_URL` environment
  variable overrides it, e.g. to point at a local test double).

In all three conditions the shared artifact is the run's contract area
(the files under `contract/` in each workspace). A role publishes only
files it changed relative to what it last saw, so a stale workspace
cannot silently overwrite newer shared state; overwriting another
role's unseen change is recorded as a rework event.

## Quick start

Prerequisites: Node ≥ 20, git (for the git condition), and the
repository's SDK built once, since the Moonbooth condition imports it:

```bash
# from the repository root
npm install
npm run build -w @moonbooth/sdk

cd labs
npm install
npm run build

# Validate the shipped scenario
node dist/cli.js validate scenarios/mb-01-cross-agent-build.json

# Full dry run: the deterministic stub adapter across all three
# conditions (the moonbooth condition creates real booths on the
# configured API; set MOONBOOTH_LABS_API_URL to a local double to keep
# it entirely local)
node dist/cli.js run scenarios/mb-01-cross-agent-build.json --dry-run
```

Runs land in `labs/runs/<experiment>/<run-id>/` with `manifest.json`,
`events.jsonl`, `export.json`, the session workspaces, and the merged
evaluation workspace. Run directories are immutable: re-running with
the same seed refuses to overwrite an existing run.

## The MB-01 scenario

`scenarios/mb-01-cross-agent-build.json` is the cross-agent build
experiment: backend, frontend, and QA roles build against a small
fixture codebase (`fixtures/mb-01/base/`) while the driver injects a
pagination contract change (offset → cursor) into the channel mid-run.
Three scripted variants cover the outcome space: coordinated adoption
(full pass), a missed change (the pair stays consistent but never
adopts the new contract), and interface drift (the client adopts, the
service does not, the roundtrip breaks). Outcome checks run an
integration suite against the merged workspace and award partial credit
per assertion.

## CLI

```
labs validate <scenario.json>
labs run <scenario.json> [--condition files|git|moonbooth]
     [--adapter stub|codex|api-session] [--seed N]
     [--budget-cap SECONDS] [--runs-dir DIR]
     [--interventions FILE] [--dry-run]
labs export <run-dir> [--out FILE] [--rebuild --scenario <scenario.json>]
```

- `--dry-run` forces the stub adapter across every condition in the
  scenario: the full pipeline at zero model cost.
- `--seed` fixes the counterbalanced condition order (Latin-square
  rotation derived from the seed) and is recorded in every manifest.
- `--budget-cap` overrides the scenario's per-run wall-time cap.
- `--interventions` points at a JSON array file whose length is the
  operator-logged human intervention count for the run. Only the count
  is recorded; the file's contents never enter a manifest or export.
  (Dropping an `interventions.json` into the run directory works too.)
- `labs export` verifies the run's sanitized export; `--rebuild`
  regenerates it from the manifest and event log.

## Scenario format

A scenario is one JSON document, validated against the schema in
`src/schema.ts` (`labs validate` prints every violation). It carries:
the experiment ID and objective; roles with owned areas and briefs;
runtime entries naming adapters; the conditions to compare; budget
caps (wall time, cost where measurable, interventions) and a stop rule;
task variants (fixture directory plus per-role steps, where a step may
skip its sync-in — which is how a variant scripts a missed change);
driver injections (files written into the channel at a step boundary);
outcome checks (shell commands with optional TAP-style partial credit,
file existence, file content), where a check may declare that its
failure counts as a missed change for a named injection; and known
limitations, which are carried into every export verbatim.

## Adapters

One interface (`src/adapters/adapter.ts`): launch an independent
session in an isolated workspace, deliver the task, collect the result.

- **stub** — deterministic scripted file operations (the step's
  `script`). This is what tests and smoke runs use. Its operations are
  scripted behavior, not model behavior, and every export from a stub
  run says so in its limitations.
- **codex** — shells to the Codex CLI (`codex exec`) with the workspace
  as its working root and the workspace-write sandbox. Token usage is
  recorded when the CLI's event stream reports it; the CLI reports no
  dollar cost, so cost stays "not reported".
- **api-session** — a skeleton for hosted model APIs: a single-turn
  chat-completions session that writes the reply to
  `session-output.md`. It reads its key from the environment variable
  named in the runtime's `apiKeyEnv` option and refuses to run when
  that variable is absent; no key is ever read from a config file.

To add an adapter: implement the interface, register it in
`createAdapter`, and give it an entry in the engine's adapter
limitations so exports describe it accurately.

To add a scenario: write the JSON, add its fixture under `fixtures/`,
and validate. Fixtures must be self-contained and synthetic; checks
must be runnable with the tools the fixture itself declares.

## Evidence rules

These bind every artifact the harness produces:

- **Observed beats claimed.** A run's evidence is its check outcomes,
  test results, wall time, token usage and cost where the adapter
  reports them, operator-logged interventions, missed changes, and
  rework events. Adapter session summaries are recorded in the manifest
  as claims and never enter the export's outcome fields.
- **"Not reported" is a valid value.** When an adapter or service does
  not report tokens or cost, the manifest records the string
  `not reported`. Costs are never estimated from token counts or price
  tables.
- **No favorable-only reporting.** Failed and null runs produce
  manifests and exports on the same footing as passing runs.
- **Exports are structurally sanitized.** The export schema is an
  allowlist with no field capable of carrying workspace contents, file
  contents, credentials, booth identifiers, or bearer URLs, and the
  serialized export is scanned for credential-shaped strings before it
  is written; a match refuses the export rather than redacting silently.
- **Budgets are Erik's call.** Scenarios carry caps and the harness
  enforces them, but choosing to spend money on real model runs is a
  human decision made per campaign, not a harness default.

## Layout

- `src/` — config schema and loading, the run engine, conditions,
  adapters, checks, manifest and export builders, the CLI.
- `scenarios/` — scenario configurations (MB-01 ships here).
- `fixtures/` — self-contained synthetic task fixtures.
- `tests/` — unit tests (validation, counterbalancing, channel
  semantics, adapter refusal paths, manifest completeness, export
  redaction) and an end-to-end dry run of MB-01 across all three
  conditions, with the moonbooth condition exercised against a local
  API double (`tests/helpers/booth-double.ts`).

## Known limitations of this increment

- Roles within a run execute sequentially; genuinely parallel sessions
  are future work.
- The channel carries the contract area only, not arbitrary workspace
  files.
- The api-session adapter is a single-turn skeleton with no tool loop.
- The end-to-end verification in this increment uses the stub adapter
  and a local booth API double; no live-service or real-model run has
  been performed with this harness yet.
