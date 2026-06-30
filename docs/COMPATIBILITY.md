# Compatibility Policy

Status: stable for `v1.10.0`.

AgentOps Workbench is a local-first review tool. Version `v1.0.0` froze the
practical contract for post-hoc ingestion, local storage migration, reports,
exports, and documented CLI workflows. Version `v1.1.0` added first-class
local capture commands for supported native stream adapters without expanding
into private transcript parsing or hosted capture. Version `v1.2.0` adds the
local Decision Dashboard for merge-readiness review, claim/evidence checks,
risk drilldown, evidence exports, and two-session comparison. Version `v1.3.0`
adds simplified `run`, `review`, `import`, and `--out` CLI workflows without
changing the underlying artifact boundary. Version `v1.4.0` added a
lower-fidelity `forensic-text` adapter for saved terminal transcripts and
copied coding-agent text. It is additive and does not change the native JSONL
recommendation for full-fidelity review. Version `v1.5.0` adds deterministic
quality gates and GitHub-ready gate output for local or CI workflows. Version
`v1.6.0` documents the source-first distribution boundary and adds synthetic
demo artifacts for adoption. Version `v1.7.0` adds guided first-run commands
for setup checks, demos, artifact audits, and PR-ready reports. Version
`v1.7.1` tightens guided setup by checking `.agentops/` ignore status and
printing the dashboard URL in demo output. Version `v1.8.0` adds safe setup
automation through `agentops init`, `agentops doctor --fix`, and
`agentops demo --serve`. Version `v1.9.0` adds a local read-only MCP server
for session/report lookup.
Version `v1.9.1` updates release smoke validation for the MCP protocol tests
without changing the public command surface. Version `v1.10.0` adds
OpenInference-style JSON span export without adding OTLP upload or collector
configuration.

## Stable Surfaces

The following surfaces are treated as public contracts in `v1.10.0`:

- `agentops.event.v1` JSONL records documented in [Event schema](EVENT_SCHEMA.md).
- `agentops.export.v1` JSON exports documented in [JSON export](EXPORT.md).
- `agentops.config.v1` configuration documented in
  [Configuration strategy](CONFIGURATION.md).
- CLI commands documented in [CLI reference](CLI.md).
- Supported adapter identifiers documented in [Adapter strategy](ADAPTER_STRATEGY.md).
- Session Markdown report and repo Markdown report section structure.
- Local dashboard CLI entrypoint and supported local UI workflows documented in
  [Dashboard](DASHBOARD.md).
- Local SQLite migration behavior for databases created by pre-1.0 releases.
- Privacy defaults: raw payload storage off, raw payload hashing on, redaction
  before storage on.

Compatible changes may add optional fields, optional report sections, new
adapter diagnostics, new commands, or new config keys with defaults. Breaking
changes to stable surfaces require a new major version or an explicit migration
path.

The `v1.1.0` capture commands are additive CLI workflows. They create local
artifacts for existing native stream adapters and do not expand the supported
input boundary to private transcript folders or hosted capture.

The `v1.2.0` dashboard views and evidence bundles are additive local review
workflows. Browser JSON endpoints are intended for the local dashboard and are
not a remote API compatibility guarantee.

The `v1.3.0` `run`, `review`, and `import` commands are additive convenience
workflows over the existing capture, ingest, inspect, report, repo-report, and
export behavior. `agentops ingest` remains supported as a compatibility alias
for `agentops import`.

The `v1.5.0` `gate` command is an additive deterministic check over stored
session analysis and current git metadata. Gate JSON uses
`agentops.gate.v1`; compatible changes may add optional fields or checks.

The `v1.6.0` distribution decision keeps fresh clones and GitHub release source
archives as the supported install paths. Npm publication and standalone
binaries remain outside the stable contract.

The `v1.7.0` `doctor`, `demo`, `audit`, and `pr` commands are additive guided
workflows over existing config, import, review, gate, dashboard, and repo-report
behavior.

The `v1.8.0` `init`, `doctor --fix`, and `demo --serve` workflows are additive
local setup conveniences. They may create `.agentops/`, add `.agentops/` to
`.gitignore`, and write a default config when missing, but they do not
overwrite existing config or manage provider credentials.

The `v1.9.0` MCP server is an additive local stdio interface. Its public
contract is the documented tool names and read-only behavior in
[MCP server](MCP.md). Compatible changes may add optional tool arguments,
optional structured fields, or new read-only tools.

The `v1.10.0` OpenInference export is an additive deterministic JSON span
bundle available through `agentops export --format openinference-json`.
Compatible changes may add optional attributes or spans, but must continue to
omit raw payload JSON by default.

## Adapter Matrix

Supported in `v1.10.0`:

| Adapter | Input boundary | Stability |
| --- | --- | --- |
| `agentops-jsonl` | Canonical `agentops.event.v1` JSONL | Stable |
| `pai-export-jsonl` | Sanitized PAI/KAI-style AgentOps JSONL export | Stable |
| `claude-code-jsonl` | Sanitized Claude Code AgentOps JSONL export | Stable |
| `codex-jsonl` | Sanitized Codex AgentOps JSONL export | Stable |
| `claude-code-stream-json` | Explicit `claude -p --output-format stream-json` JSONL capture | Supported native stream |
| `codex-exec-jsonl` | Explicit `codex exec --json` JSONL capture | Supported native stream |
| `forensic-text` | Saved terminal transcript or copied coding-agent text | Experimental forensic import |

Native stream adapters are tested with synthetic fixtures and clear diagnostics
for unsupported shapes. They are not private transcript parsers.

`agentops capture codex` and `agentops capture claude` are convenience commands
for producing these explicit local artifacts. Captured stdout is written to
ignored local paths such as `.agentops/captures/`; provider stderr remains
separate and is not part of the JSONL artifact.

## Unsupported Or Experimental

The following are intentionally outside the `v1.10.0` stable contract:

- Raw Claude Code transcript-file parsing.
- Private PAI memory store reads.
- Live hook tailing or real-time agent control.
- Hosted dashboard operation, auth, teams, or remote API compatibility.
- MCP write tools, live agent control, or remote MCP hosting.
- OTLP/protobuf export or collector upload.
- Npm publication. The package remains `"private": true` until a future release
  checklist explicitly approves publishing.
- Windows support claims. CI covers Ubuntu, and macOS is manually exercised.

The hook envelope documented in [Hook Envelope JSONL](HOOK_ENVELOPE.md) is a
local template output shape, not a live ingestion API in `v1.10.0`.

## Reports

Markdown reports may add new sections over time, but `v1.0.0` preserves the
core user-facing sections:

- session summary
- timeline
- files touched
- commands run
- verification evidence
- risk flags
- usage when available

Repo reports preserve:

- review summary
- current git changes
- observed and unobserved git changes
- agent-only files
- verification and risk sections

The GitHub-format repo report remains stdout-only and does not post to GitHub.

## Storage And Migrations

The SQLite store is local implementation detail, but migrations are part of the
user experience. `v1.0.0` supports migrating known pre-1.0 local schemas covered
by `test/store-migration.test.ts`.

Users should not depend on raw table layouts for automation. Use
`agentops export --format json` for portable data.

## Privacy Contract

Public examples, fixtures, reports, screenshots, and release artifacts must not
include private transcripts, private PAI memory, credentials, local absolute
paths, account identifiers, or private repository names.

Run before public release:

```bash
bun run ci
bun run smoke:install
bun run smoke:package
bun run smoke:pack-install
bun run smoke:large-session
bun run smoke:dashboard
```
