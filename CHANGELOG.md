# Changelog

## v1.2.0 - 2026-06-29

### Added

- Decision Dashboard merge-readiness summary for selected sessions.
- Claim-vs-evidence matrix for tests, lint, typecheck, build, and final
  success claims.
- Risk severity drilldown with linked event, command, file, and evidence
  context.
- Two-session run comparison for readiness, risks, verification, files,
  commands, usage, and risk categories.
- Dashboard JSON evidence bundle export endpoint and `JSON evidence` link.
- Synthetic dashboard demo states for ready, needs-review, blocked, empty, and
  comparison flows.
- Current v1.2 dashboard screenshot asset.

### Changed

- Dashboard smoke now covers decision payloads, evidence export hygiene, risk
  drilldown, run comparison, and representative demo states.
- Dashboard docs and README now describe the v1.2 decision dashboard workflow.

## v1.1.0 - 2026-06-29

### Added

- `agentops capture codex` for local `codex exec --json` capture workflows.
- `agentops capture claude` for local Claude Code `stream-json` capture
  workflows.
- Opt-in Codex and Claude Code hook templates that write bounded local
  `agentops.hook-envelope.v1` JSONL artifacts.
- Synthetic hook-envelope fixture coverage.

### Changed

- Claude Code stream detection now recognizes streams that begin with hook
  system events before the session init event.
- Capture docs now describe first-class capture commands, stdout/stderr
  separation, redaction review, and hook template installation boundaries.

## v1.0.0 - 2026-06-28

### Added

- Stable compatibility policy for schemas, adapters, CLI commands, config,
  reports, exports, migrations, and privacy defaults.
- Clone smoke coverage for session reports, repo reports, GitHub-format repo
  reports, JSON export, adapter fixture detection, and dashboard checks.

### Changed

- Package metadata now reports `1.0.0` while npm publication remains deferred
  and `"private": true` stays intentional.
- README, roadmap, CLI, adapter, schema, export, config, packaging, dashboard,
  and PAI docs now point to the same stable/experimental support boundaries.

## v0.9.0 - 2026-06-28

### Added

- Packed npm tarball install smoke that runs the CLI from extracted package contents.
- Dashboard smoke script covering the HTML shell, session API, usage summary, and Markdown report endpoint.
- Golden Markdown report regression fixture and test.
- Reusable release template.

### Changed

- CI now runs package smoke, packed install smoke, large-session smoke, and dashboard smoke.
- Packaging strategy now explicitly defers npm publication through `v1.0.0` and keeps `"private": true` intentional.
- Release checklist is reusable for every release instead of being tied to initial public readiness.

## v0.8.0 - 2026-06-28

### Added

- `agentops export --session <id> --format json` for deterministic session JSON export.
- `agentops export --session <id> --format json --scope repo` for repo-aware JSON export.
- `agentops.export.v1` documentation with privacy defaults and compatibility notes.
- Sanitized hook-envelope JSONL documentation for future local capture integrations.
- OpenTelemetry/GenAI standards mapping notes.
- Export compatibility tests.

### Changed

- OTLP export is explicitly deferred until after `v1.0.0`; future OTLP work should transform `agentops.export.v1`.

## v0.7.0 - 2026-06-28

### Added

- `agentops config --check` for config validation and suppression guardrails.
- Native Claude Code and Codex edge fixtures for partial streams, failed commands, permission-denied output, and retry-like flows.
- Line-specific diagnostics for unsupported native Claude Code and Codex JSONL record shapes.
- Redaction regression coverage for credential-like values, local paths, emails, and nested transcript payloads.
- SQLite migration regression coverage for older local database schemas.
- Large synthetic session smoke for ingest, analysis, and report generation.

### Changed

- CI smoke now covers config validation, native edge fixtures, and the large-session baseline.

## v0.6.0 - 2026-06-28

### Added

- Safe capture guide for native Codex JSONL, Claude Code stream JSON, and PAI/KAI-style post-hoc exports.
- Dashboard Markdown report export for selected sessions.
- Specific evidence-claim flags for missing test, lint, typecheck, and build command evidence.

### Changed

- Markdown reports now group risk flags by severity.
- Documented that generated-file and retry/loop detectors remain in the `v0.7.0` hardening milestone pending broader fixture coverage.

## v0.5.0 - 2026-06-28

### Added

- Native `claude -p --output-format stream-json` JSONL adapter with synthetic fixture coverage.
- Dashboard session search and adapter filtering.
- Npm source package strategy, explicit package contents, and package dry-run smoke.

## v0.4.0 - 2026-06-28

### Added

- Native `codex exec --json` JSONL adapter with synthetic fixture coverage.
- Dashboard MCP/tool usage summary backed by SQLite.
- Release archive smoke script for validating GitHub source archives.
- Claude Code stream JSON fixture research and public-safe fixture plan.

## v0.3.0 - 2026-06-28

### Added

- Optional token and cost usage metadata ingestion, storage, and report rendering.
- Installation strategy documentation and install smoke verification.
- Native Claude Code and Codex adapter research with recommended CLI JSONL targets.
- Local dashboard foundation with SQLite-backed session, timeline, risk, command, and file views.

## v0.2.0 - 2026-06-28

### Added

- `agentops adapters` and `agentops adapters --input <file>` for adapter discovery and detection diagnostics.
- `agentops sessions` for listing ingested sessions.
- `agentops inspect --session <id|latest>` for compact session inspection.
- Sanitized AgentOps JSONL export adapters for Claude Code and Codex.
- Synthetic Claude Code and Codex fixture coverage.
- CLI reference documentation.

### Notes

- Claude Code and Codex support currently means normalized, sanitized AgentOps JSONL exports.
- Native runtime transcript parsing remains planned future work.

## v0.1.0 - 2026-06-28

### Added

- Canonical AgentOps JSONL ingestion.
- PAI export JSONL ingestion.
- Local SQLite session store.
- Markdown session reports.
- Local repo reports.
- GitHub-ready PR comment report output.
- Configurable risk and evidence checks.
- `agentops scan-publication` baseline public-readiness scan.

### Security And Release

- Public-readiness checklist passed.
- Main branch protection enabled.
- Required `Test` and `GitGuardian Security Checks` checks enabled.
- GitHub secret scanning, push protection, and Dependabot security updates enabled.
