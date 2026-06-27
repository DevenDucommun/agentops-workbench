# Roadmap

## North Star

Make coding-agent work reviewable, auditable, and safer to trust.

## Phase 0: Public-Ready Foundation

Status: in progress.

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

Outcomes:

- Public adapter interface for local agent-session exporters.
- Optional PAI-compatible post-hoc import path.
- Direct Claude/Codex adapter strategy after sanitized fixture review.
- Optional hook-envelope JSONL writer.
- Clear documentation that PAI private memory stores are out of scope.

Exit criteria:

- PAI-compatible data path uses sanitized exported artifacts only.
- No private PAI deployment details appear in public docs, fixtures, or tests.
- Integration works without requiring PAI to be installed.

## Phase 5: Dashboard

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

Outcomes:

- JSON export.
- OTLP/OpenTelemetry export spike.
- OpenTelemetry GenAI semantic convention mapping notes.
- Import/export compatibility tests.

Exit criteria:

- Internal schema can export trace-like data without losing core coding-agent fields.
- Standards mapping is documented and versioned.

## Phase 7: Public Launch

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
