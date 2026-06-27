# Implementation Plan: AgentOps Workbench MVP

## Technical Context

- Language/runtime: TypeScript on Bun.
- Storage: SQLite through Bun's SQLite API.
- Interface: CLI first.
- Primary output: Markdown report.
- Test framework: Bun test.
- Public posture: private development repo intended for public release.

## Architecture Decisions

### Decision 1: CLI Before Dashboard

The first durable product surface is the CLI and Markdown report. This keeps the MVP useful while the event model is still evolving.

### Decision 2: Synthetic Fixtures First

The project starts with synthetic JSONL fixtures. Real transcripts are introduced only after redaction and public-readiness controls exist.

### Decision 3: Deterministic Rules Before LLM Evals

Risk and evidence scoring starts as deterministic rules. LLM-based grading can be added later, but only after baseline capture and redaction are reliable.

### Decision 4: Optional PAI Integration

PAI compatibility is implemented through exported artifacts or hook envelopes. AgentOps Workbench does not read private PAI memory stores and does not require PAI to run.

### Decision 5: OpenTelemetry Alignment Later

The normalized event model should be compatible with future OTLP export, but MVP does not implement OTLP export.

## Milestones

### M0: Current Slice

- CLI entrypoint.
- JSONL parser.
- SQLite store.
- Analyzer baseline.
- Markdown report.
- Synthetic fixture.
- Parser/report tests.

### M1: Public Planning And Hygiene

- Public architecture docs.
- Research landscape docs.
- PAI integration boundary.
- Publication/privacy plan.
- Spec Kit-style spec, plan, and tasks.
- Ignore rules for local/private artifacts.

### M2: Schema And Adapter Hardening

- Version event schema.
- Add adapter interface.
- Add redaction pipeline.
- Add migration tests.
- Add fixture variants.

### M3: Risk Engine

- Rule registry.
- Structured severity taxonomy.
- Rule tests.
- Report grouping.
- Suppression config.

### M4: Repo/PR Mode

- Git diff summarizer.
- Agent-event to file-change mapping.
- PR-ready report.
- Local-only and GitHub-ready output modes.

### M5: Optional Integrations

- PAI-compatible post-hoc import.
- Hook-envelope format.
- JSON export.
- OpenTelemetry mapping spike.

### M6: Dashboard

- Local web UI over SQLite.
- Timeline, risk/evidence, files, commands, and tool map.

## Risks And Mitigations

- Risk: leaking private transcript data. Mitigation: synthetic fixtures, ignore rules, redaction pipeline, public-release scans.
- Risk: generic observability positioning. Mitigation: focus on repo-aware coding-agent audit reports.
- Risk: adapter lock-in. Mitigation: strict normalized event boundary.
- Risk: PAI coupling. Mitigation: optional exported artifacts only.
- Risk: dashboard distracts from schema quality. Mitigation: dashboard deferred until CLI/report workflow is useful.

## Validation

- `bun test`
- CLI ingest/report smoke test.
- public-readiness grep.
- fixture determinism check.
- manual review of generated report.
