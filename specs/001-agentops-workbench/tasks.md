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
- [x] Add license decision.
- [x] Add `SECURITY.md`.
- [x] Add `CONTRIBUTING.md`.

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
- [x] Add cost/token extractor.
- [x] Add config-based suppression support.
- [ ] Group report findings by severity.
- [ ] Add tests for every rule category.

## M4 Repo/PR Mode

- [x] Add git diff reader.
- [x] Add changed-file summarizer.
- [x] Map file changes to agent events.
- [x] Add PR-ready Markdown output.
- [x] Add local-only mode.
- [x] Add GitHub comment body output without posting.

## M5 Optional PAI And Standards Integrations

- [ ] Define sanitized hook-envelope JSONL format.
- [x] Add PAI-compatible post-hoc import docs.
- [x] Add PAI-compatible post-hoc import implementation.
- [x] Add direct Claude/Codex adapter research notes after sanitized fixture review.
- [x] Add optional PAI fixture generated from synthetic data.
- [ ] Add JSON export.
- [ ] Draft OpenTelemetry mapping table.
- [ ] Spike OTLP export.

## M6 Dashboard

- [x] Select local dashboard stack.
- [x] Add session list.
- [x] Add timeline view.
- [x] Add risk/evidence cards.
- [x] Add files and commands drilldown.
- [x] Add MCP/tool usage map.

## M7 Public Launch

- [x] Initialize GitHub repo.
- [x] Enable secret scanning and dependabot alerts where available.
- [x] Enable `main` branch protection when GitHub account/repo visibility supports it.
- [x] Add CI workflow.
- [x] Run public-readiness scan.
- [x] Replace any private artifacts with synthetic examples.
- [x] Confirm fresh clone instructions.
- [x] Publish repository.

## M8 Roadmap To 1.0

- [x] Define `v0.6.0` through `v1.0.0` roadmap.
- [x] Document 1.0 public contract candidates.
- [x] Document milestone exit criteria and dependencies.
- [x] Create GitHub milestones for `v0.6.0` through `v1.0.0`.
- [x] Create roadmap issues for each milestone.

## M9 1.0 Stabilization Backlog

- [ ] Add safe capture guide for native Claude Code and Codex streams.
- [ ] Add dashboard Markdown report export.
- [ ] Expand unsupported evidence-claim detection.
- [ ] Add adapter schema-drift diagnostics.
- [ ] Add config validation command or mode.
- [ ] Add migration tests for older SQLite schemas.
- [ ] Add JSON export.
- [ ] Draft OpenTelemetry mapping table.
- [ ] Decide npm package publishing path.
- [ ] Add package smoke to CI if stable.
- [ ] Add dashboard browser or screenshot smoke.
- [ ] Add report golden/snapshot tests.
- [ ] Document stable `v1.0.0` compatibility policy.
