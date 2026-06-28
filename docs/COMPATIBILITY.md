# Compatibility Policy

Status: stable for `v1.0.0`.

AgentOps Workbench is a local-first review tool. Version `v1.0.0` freezes the
practical contract for post-hoc ingestion, local storage migration, reports,
exports, and documented CLI workflows.

## Stable Surfaces

The following surfaces are treated as public contracts in `v1.0.0`:

- `agentops.event.v1` JSONL records documented in [Event schema](EVENT_SCHEMA.md).
- `agentops.export.v1` JSON exports documented in [JSON export](EXPORT.md).
- `agentops.config.v1` configuration documented in
  [Configuration strategy](CONFIGURATION.md).
- CLI commands documented in [CLI reference](CLI.md).
- Supported adapter identifiers documented in [Adapter strategy](ADAPTER_STRATEGY.md).
- Session Markdown report and repo Markdown report section structure.
- Local SQLite migration behavior for databases created by pre-1.0 releases.
- Privacy defaults: raw payload storage off, raw payload hashing on, redaction
  before storage on.

Compatible changes may add optional fields, optional report sections, new
adapter diagnostics, new commands, or new config keys with defaults. Breaking
changes to stable surfaces require a new major version or an explicit migration
path.

## Adapter Matrix

Supported in `v1.0.0`:

| Adapter | Input boundary | Stability |
| --- | --- | --- |
| `agentops-jsonl` | Canonical `agentops.event.v1` JSONL | Stable |
| `pai-export-jsonl` | Sanitized PAI/KAI-style AgentOps JSONL export | Stable |
| `claude-code-jsonl` | Sanitized Claude Code AgentOps JSONL export | Stable |
| `codex-jsonl` | Sanitized Codex AgentOps JSONL export | Stable |
| `claude-code-stream-json` | Explicit `claude -p --output-format stream-json` JSONL capture | Supported native stream |
| `codex-exec-jsonl` | Explicit `codex exec --json` JSONL capture | Supported native stream |

Native stream adapters are tested with synthetic fixtures and clear diagnostics
for unsupported shapes. They are not private transcript parsers.

## Unsupported Or Experimental

The following are intentionally outside the `v1.0.0` stable contract:

- Raw Claude Code transcript-file parsing.
- Private PAI memory store reads.
- Live hook tailing or real-time agent control.
- Hosted dashboard operation, auth, teams, or remote API compatibility.
- OpenTelemetry/OTLP export.
- Npm publication. The package remains `"private": true` until a future release
  checklist explicitly approves publishing.
- Windows support claims. CI covers Ubuntu, and macOS is manually exercised.

The hook envelope documented in [Hook Envelope JSONL](HOOK_ENVELOPE.md) is a
future integration shape, not a live ingestion API in `v1.0.0`.

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
