# Feature Specification: AgentOps Workbench MVP

**Feature Branch**: `001-agentops-workbench`  
**Created**: 2026-06-27  
**Status**: Implemented MVP; maintained as public planning reference  
**Input**: Build a public-ready local observability and audit tool for coding-agent sessions, with PAI-compatible integration boundaries and private-to-public repo hygiene.

## User Scenarios

### Scenario 1: Review A Completed Agent Session

A developer runs an AI coding agent, exports a session artifact, ingests it into AgentOps Workbench, and generates a Markdown report showing timeline, files touched, commands run, verification evidence, risk flags, and final outcome.

### Scenario 2: Prepare A PR Audit Report

A developer wants to attach evidence to an AI-authored PR. AgentOps Workbench summarizes agent actions, repo changes, tests, risk signals, and any unsupported success claims in a PR-ready report.

### Scenario 3: Use With A Local PAI Deployment

A user with a local personal assistant deployment exports a sanitized agent-session artifact. AgentOps Workbench ingests the artifact without reading private memory stores or requiring PAI-specific internals.

### Scenario 4: Publish The Repo Safely

The maintainer develops privately, then runs publication checks to confirm that fixtures, docs, generated reports, local stores, and planning artifacts are safe for a public GitHub repository.

## Functional Requirements

- FR-001: The CLI must ingest a JSONL session artifact.
- FR-002: The parser must identify session metadata and normalized events.
- FR-003: The store must persist sessions, events, commands, file changes, and risk flags in SQLite.
- FR-004: The analyzer must flag destructive commands, permission changes, secret-looking values, sensitive file changes, production/deployment config changes, large churn, and unsupported success claims.
- FR-005: The report generator must emit deterministic Markdown.
- FR-006: The report must distinguish observed evidence from final-agent claims.
- FR-007: The product must work offline for ingest, analysis, storage, and report generation.
- FR-008: The repo must include public-safe planning and architecture documentation.
- FR-009: The project must define a PAI integration boundary that avoids private memory stores and private deployment details.
- FR-010: The project must include publication and privacy controls before public launch.

## Non-Functional Requirements

- NFR-001: Core commands should run locally without network access.
- NFR-002: Reports should be deterministic for the same stored session data.
- NFR-003: Fixtures must be synthetic or redacted.
- NFR-004: Local databases and agent-local folders must be ignored.
- NFR-005: Adapter logic must be isolated from analyzer/report logic.
- NFR-006: Schema evolution must be deliberate and migration-friendly.

## Success Criteria

- SC-001: `agentops ingest ./fixtures/sample-session.jsonl` imports the sample session.
- SC-002: `agentops report --session latest > report.md` generates a readable report.
- SC-003: Test suite passes from a fresh clone.
- SC-004: Public-readiness scan finds no local absolute paths, secrets, raw PAI memory, or private session data in tracked files.
- SC-005: A reviewer can understand roadmap, architecture, and PAI boundaries from committed docs.

## Out Of Scope For MVP

- Hosted SaaS.
- Multi-user auth.
- Full dashboard.
- Live agent control.
- LLM-as-judge scoring.
- Direct PAI memory access.
- Raw transcript publication.

## Resolved MVP Questions

- Native Codex `codex exec --json` and Claude Code `stream-json` became the
  first direct runtime adapters.
- PAI integration is implemented as a core post-hoc import path for sanitized
  exported artifacts, not as direct private memory access.
- Configuration lives in `agentops.config.json`-style local config files, with
  suppressions and risk/evidence settings documented in `docs/CONFIGURATION.md`.
- The project is licensed under the repository `LICENSE`.

## 1.0 Decisions

- Stable surfaces are documented in `docs/COMPATIBILITY.md`: CLI commands,
  `agentops.event.v1`, `agentops.export.v1`, `agentops.config.v1`, reports,
  supported adapters, migrations, and privacy defaults.
- Npm publishing remains deferred after `v1.0.0`; the repository keeps
  `"private": true` until a future release checklist explicitly approves
  publication.
- OTLP/OpenTelemetry export remains a documented mapping only. JSON export is
  the stable portable data format.
