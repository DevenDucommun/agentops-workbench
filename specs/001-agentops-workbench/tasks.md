# Tasks: AgentOps Workbench MVP

## M0 Current Slice

- [x] Create Bun/TypeScript project metadata.
- [x] Add CLI entrypoint.
- [x] Add JSONL parser.
- [x] Add SQLite store.
- [x] Add analyzer baseline.
- [x] Add Markdown report generator.
- [x] Add synthetic sample fixture.
- [x] Add parser and report tests.
- [x] Verify ingest/report commands.

## M1 Public Planning And Hygiene

- [x] Add public architecture documentation.
- [x] Add research landscape documentation.
- [x] Add PAI integration boundary documentation.
- [x] Add publication and privacy plan.
- [x] Add Spec Kit-style constitution.
- [x] Add Spec Kit-style spec, plan, and task artifacts.
- [x] Update ignore rules for local/private artifacts.
- [ ] Add license decision.
- [ ] Add `SECURITY.md`.
- [ ] Add `CONTRIBUTING.md`.

## M2 Schema And Adapter Hardening

- [x] Define versioned normalized event schema.
- [x] Document canonical `agentops-event-v1` JSONL.
- [x] Add adapter interface.
- [x] Move JSONL parser behind adapter interface.
- [x] Add redaction pipeline.
- [x] Add payload hash support.
- [x] Add raw payload retention configuration.
- [x] Add fixture for missing timestamps.
- [x] Add fixture for malformed records.
- [x] Add fixture for risky command/file edits.

## M3 Risk And Evidence Engine

- [ ] Create rule registry.
- [x] Add severity taxonomy.
- [ ] Add generated-file detector.
- [ ] Add retry/loop detector.
- [ ] Add cost/token extractor.
- [x] Add config-based suppression support.
- [ ] Group report findings by severity.
- [ ] Add tests for every rule category.

## M4 Repo/PR Mode

- [ ] Add git diff reader.
- [ ] Add changed-file summarizer.
- [ ] Map file changes to agent events.
- [ ] Add PR-ready Markdown output.
- [ ] Add local-only mode.
- [ ] Add GitHub comment body output without posting.

## M5 Optional PAI And Standards Integrations

- [ ] Define sanitized hook-envelope JSONL format.
- [ ] Add PAI-compatible post-hoc import docs.
- [x] Add PAI-compatible post-hoc import implementation.
- [ ] Add direct Claude/Codex adapter research notes after sanitized fixture review.
- [x] Add optional PAI fixture generated from synthetic data.
- [ ] Add JSON export.
- [ ] Draft OpenTelemetry mapping table.
- [ ] Spike OTLP export.

## M6 Dashboard

- [ ] Select local dashboard stack.
- [ ] Add session list.
- [ ] Add timeline view.
- [ ] Add risk/evidence cards.
- [ ] Add files and commands drilldown.
- [ ] Add MCP/tool usage map.

## M7 Public Launch

- [ ] Initialize private GitHub repo.
- [ ] Enable secret scanning and dependabot alerts where available.
- [ ] Enable `main` branch protection when GitHub account/repo visibility supports it.
- [ ] Add CI workflow.
- [ ] Run public-readiness scan.
- [ ] Replace any private artifacts with synthetic examples.
- [ ] Confirm fresh clone instructions.
- [ ] Publish repository.
