# Roadmap

## North Star

Make coding-agent work reviewable, auditable, and safer to trust.

## Current Status

Public release: `v0.4.0`

Implemented:

- Local CLI ingestion and reporting.
- Versioned `agentops.event.v1` JSONL schema.
- SQLite-backed local session store.
- Risk and evidence checks.
- Repo-aware Markdown reports.
- GitHub-ready PR comment Markdown output.
- Session listing and inspection commands.
- Sanitized export adapters for AgentOps JSONL, PAI, Claude Code, and Codex.
- Native Codex `codex exec --json` ingestion.
- Native Claude Code `stream-json` ingestion.
- Public-readiness scan, CI, branch protection, GitGuardian checks, secret scanning, and Dependabot security updates.
- Local dashboard foundation backed by SQLite.
- Dashboard MCP/tool usage map.
- Release archive smoke automation.

Current boundary:

- Claude Code and Codex support includes normalized, sanitized AgentOps JSONL exports plus explicit native CLI JSONL streams.
- Raw Claude Code transcript-file parsing remains out of scope.
- Dashboard foundation is implemented with tool usage summary; richer visualization remains future work.

## v0.5 Focus

This release expands native runtime ingestion and starts packaging/dashboard
polish.

In progress:

- Native Claude Code `claude -p --output-format stream-json` adapter and synthetic fixture coverage.
- Dashboard filtering and tool-map polish.
- Install/package distribution strategy beyond fresh clone and source archive.

## v0.4 Focus

This release completes the first native runtime ingestion path and tightens
release validation.

Delivered:

- Native Codex `codex exec --json` adapter and synthetic fixture coverage.
- Claude Code stream JSON fixture research and public-safe fixture decision.
- Dashboard MCP/tool usage map backed by SQLite.
- Release archive smoke script for validating GitHub source archives.

## v0.3 Focus

This release makes the project easier to validate against real-world agent workflows while preserving privacy boundaries.

Delivered:

- Native Claude Code transcript research and fixture design.
- Native Codex transcript research and fixture design.
- Token/cost reporting model for sources that provide usage metadata.
- Local dashboard foundation backed by the existing SQLite store.
- Install/package strategy beyond local `./bin/agentops`.

## Phase 0: Public-Ready Foundation

Status: complete in `v0.1.0`.

Outcomes:

- TypeScript/Bun project scaffold.
- CLI entrypoint.
- Synthetic JSONL fixture.
- SQLite local store.
- Markdown report generation.
- Basic risk/evidence checks.
- Public planning docs and Spec Kit artifacts.
- Git ignore rules for local data and private agent folders.

Exit criteria:

- `agentops ingest ./fixtures/sample-session.jsonl` works.
- `agentops report --session latest > report.md` works.
- Tests cover parser and report baseline.
- Public-readiness scan has no obvious PII, local path, secret, or raw transcript leaks.

## Phase 1: Stable Ingestion And Schema

Status: substantially complete in `v0.2.0`; native adapter research is documented in `v0.3.0`.

Outcomes:

- Versioned normalized event schema.
- Adapter contract and fixture format.
- Canonical `agentops-event-v1` JSONL documentation.
- Redaction pipeline before persistence.
- Source metadata without private path leakage.
- Parser tests for malformed, partial, and mixed event streams.
- Store migration strategy.

Exit criteria:

- At least two sanitized fixture variants ingest deterministically.
- Raw payload retention is configurable.
- Reports do not expose local absolute paths by default.

## Phase 2: Risk And Evidence Engine

Status: initial implementation complete; rule coverage will continue expanding.

Outcomes:

- Rule registry.
- Severity taxonomy.
- Risk categories for destructive commands, permission changes, secrets, sensitive paths, production config edits, generated files, and large churn.
- Evidence categories for tests, lint, typecheck, build, manual review, and missing verification.
- Final-claim vs evidence detector.

Exit criteria:

- Rules are unit tested.
- Reports group findings by severity.
- False-positive suppressions are supported through a local config file.

## Phase 3: PR/Repo Report

Status: complete for local Markdown and GitHub-ready stdout output.

Outcomes:

- Git diff summarizer.
- Mapping between agent events and current repo changes.
- PR-ready Markdown report.
- Optional GitHub comment body output.
- Local-only mode that never calls GitHub.

Exit criteria:

- `agentops repo-report > agentops-report.md` produces a useful review artifact.
- Report distinguishes observed agent actions from current working tree state.

## Phase 4: PAI And Agent Runtime Integrations

Status: PAI-compatible and Claude/Codex sanitized export paths are implemented. Native Codex exec and Claude stream JSON parsers are implemented for explicit CLI JSONL artifacts.

Outcomes:

- Public adapter interface for local agent-session exporters.
- Optional PAI-compatible post-hoc import path.
- Direct Claude/Codex adapter strategy after sanitized fixture review.
- Native Codex and Claude CLI JSONL stream adapters.
- Optional hook-envelope JSONL writer.
- Clear documentation that PAI private memory stores are out of scope.

Exit criteria:

- PAI-compatible data path uses sanitized exported artifacts only.
- No private PAI deployment details appear in public docs, fixtures, or tests.
- Integration works without requiring PAI to be installed.

## Phase 5: Dashboard

Status: foundation implemented for `v0.3.0`; MCP/tool usage summary added in `v0.4.0`; richer visualization remains future work.

Outcomes:

- Local web dashboard.
- Session list.
- Timeline view.
- Risk/evidence cards.
- File/command drilldowns.
- MCP/tool usage map.

Exit criteria:

- Dashboard reads from SQLite only.
- CLI remains fully useful without the dashboard.
- Screenshots use synthetic sessions.

## Phase 6: Standards And Export

Status: not started.

Outcomes:

- JSON export.
- OTLP/OpenTelemetry export spike.
- OpenTelemetry GenAI semantic convention mapping notes.
- Import/export compatibility tests.

Exit criteria:

- Internal schema can export trace-like data without losing core coding-agent fields.
- Standards mapping is documented and versioned.

## Phase 7: Public Launch

Status: complete in `v0.1.0`, with `v0.4.0` now published.

Outcomes:

- Public GitHub repo.
- License.
- Security policy.
- Contribution guide.
- Clean README demo.
- Sanitized screenshots and generated report examples.
- CI test workflow.
- Release notes.

Exit criteria:

- Secret/PII scan passes.
- Repo has no local DBs, raw transcripts, private paths, or private PAI data.
- Installation instructions work from a fresh clone.
- The demo can be completed in under five minutes.
