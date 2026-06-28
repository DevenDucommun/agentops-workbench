# Roadmap To 1.0

## North Star

Make coding-agent work reviewable, auditable, and safer to trust.

AgentOps Workbench should let a developer or engineering leader answer, from
local evidence, what an AI coding agent did, what changed in the repo, what
verification happened, what risk was introduced, and whether the final claim is
supported.

## Current Status

Current public release: `v0.5.0`

Implemented:

- Local CLI ingestion and reporting.
- Versioned `agentops.event.v1` JSONL schema.
- SQLite-backed local session store.
- Deterministic risk and evidence checks.
- Repo-aware Markdown reports.
- GitHub-ready PR comment Markdown output.
- Session listing and inspection commands.
- Sanitized export adapters for AgentOps JSONL, PAI/KAI-style exports,
  Claude Code, and Codex.
- Native Codex `codex exec --json` ingestion.
- Native Claude Code `stream-json` ingestion.
- Public-readiness scan, CI, branch protection, GitGuardian checks, secret
  scanning, and Dependabot security updates.
- Local dashboard backed by SQLite, including session filtering, timeline,
  risk/evidence summaries, command/file drilldowns, usage summary, and
  MCP/tool usage map.
- Install smoke, package dry-run smoke, and release archive smoke automation.

Current boundaries:

- Claude Code and Codex support includes normalized sanitized AgentOps JSONL
  exports plus explicit native CLI JSONL streams.
- Raw Claude Code transcript-file parsing remains out of scope.
- PAI support is post-hoc and artifact-based. AgentOps does not read private
  PAI memory stores.
- The dashboard is local-first and useful, but its browser API is not a stable
  remote contract.
- The npm package strategy is documented, but the package is not yet published.

## 1.0 Definition

`v1.0.0` means the local review workflow is stable enough for external users to
build habits and lightweight automation around it.

By `v1.0.0`, these surfaces should be treated as public contracts:

- `agentops.event.v1` schema and compatibility policy.
- Supported adapter names and their documented input boundaries.
- CLI commands for ingest, sessions, inspect, report, repo-report, dashboard
  check, configuration validation, and publication scan.
- Markdown report structure for session reports and repo/PR reports.
- Configuration file shape, including redaction, evidence commands, risk paths,
  raw payload retention, and suppressions.
- SQLite migration behavior for existing local databases.
- Release validation steps for fresh clone, package/archive smoke, CI, and
  privacy checks.

`v1.0.0` does not mean hosted SaaS, multi-user auth, deep model evaluation,
live agent control, or raw private transcript ingestion.

## Release Ladder

### v0.6.0: Roadmap, Capture, And Evidence Hardening

Tracking issue: [#37](https://github.com/DevenDucommun/agentops-workbench/issues/37)

Purpose: make the current product easier to use safely and make the analyzer
more honest about unsupported claims.

Scope:

- Safe capture guide for Claude Code, Codex, and PAI/KAI-style post-hoc JSONL
  artifacts.
- Explicit guidance that raw captures stay ignored and local unless sanitized.
- Dashboard Markdown report export for a selected session.
- Stronger final-claim checks for claimed tests, lint, typecheck, or build
  success without matching command evidence.
- Report grouping improvements for risk severity and verification evidence.
- Generated-file and retry/loop detector decisions: implement the narrow useful
  cases or document why they are deferred.
- Spec Kit and planning docs synchronized with the actual public `v0.5.0`
  product state.

Exit criteria:

- `docs/CAPTURE_GUIDE.md` documents safe local capture and redaction review.
- Dashboard exposes a local Markdown report path or action for the selected
  session.
- Analyzer tests cover specific unsupported evidence claims.
- Roadmap, Spec Kit tasks, architecture, and PAI docs do not contradict the
  current release state.
- `bun run ci`, `bun run smoke:install`, and `bun run smoke:package` pass.

Dependencies:

- Existing adapter interface.
- Existing redaction pipeline.
- Existing dashboard and report generator.

### v0.7.0: Adapter, Privacy, And Config Hardening

Tracking issue: [#38](https://github.com/DevenDucommun/agentops-workbench/issues/38)

Purpose: make supported ingestion paths more robust before declaring public
contract stability.

Scope:

- Schema-drift diagnostics for native Claude Code and Codex streams.
- Fixture matrix for partial streams, malformed events, failed commands,
  permission-denied outputs, retries, and unsupported shapes.
- Config validation command or validation mode.
- Suppression guardrails so suppressions are deliberate and reviewable.
- Stronger redaction fixtures for credentials, local paths, emails, and
  transcript-like payloads.
- Large-session performance baseline for ingest, analysis, and report
  generation.
- Migration tests for older SQLite schemas.

Exit criteria:

- Unsupported native adapter shapes fail with clear diagnostics.
- Public fixture suite remains synthetic and redacted.
- Config validation catches malformed suppressions and risky raw-payload
  settings.
- Migration tests cover at least one prior schema shape.
- Large synthetic session smoke has documented runtime expectations.

Dependencies:

- v0.6 analyzer/report cleanup.
- Stable enough fixture format for regression tests.

### v0.8.0: Export And Standards

Tracking issue: [#40](https://github.com/DevenDucommun/agentops-workbench/issues/40)

Purpose: make AgentOps data portable without weakening the local-first privacy
posture.

Scope:

- JSON export for sessions and repo reports.
- Documented sanitized hook-envelope JSONL format.
- PAI/KAI post-hoc import docs updated against the implemented adapter path.
- OpenTelemetry and GenAI semantic convention mapping notes.
- OTLP export spike with explicit keep/defer decision.
- Import/export compatibility tests.

Exit criteria:

- `agentops export --format json` or equivalent command emits deterministic
  JSON for a stored session.
- JSON export omits raw private payloads by default.
- Standards mapping is documented and versioned.
- Compatibility tests prove exported data can be read back or validated against
  the documented shape.
- OTLP export is either implemented as experimental or explicitly deferred with
  rationale.

Dependencies:

- v0.7 config and privacy hardening.
- Stable normalized event shape.

### v0.9.0: Packaging, Dashboard Verification, And Release Automation

Tracking issue: [#41](https://github.com/DevenDucommun/agentops-workbench/issues/41)

Purpose: make installation and release validation boring enough for users
outside the original development environment.

Scope:

- Final npm source-package decision: publish, defer, or replace with a clearer
  distribution path.
- Align `package.json` `private` with the packaging decision.
- Packed tarball install smoke, not only `npm pack --dry-run`.
- Add package smoke to CI if it is stable on GitHub runners.
- Multi-platform or clearly documented platform coverage decision.
- Dashboard browser smoke or screenshot verification using synthetic data.
- Golden/snapshot tests for report output.
- Version-current release checklist template.

Exit criteria:

- A fresh user can install and run the CLI using the documented primary path.
- CI verifies clone smoke, package smoke, tests, typecheck, publication scan,
  and core CLI report generation.
- Dashboard is either marked experimental with tested API coverage or has a
  browser smoke baseline.
- Release checklist is not tied only to `v0.1.0`; it is reusable for each
  release.

Dependencies:

- v0.8 export decision.
- Stable CLI commands for install docs.

### v1.0.0: Stable Local Agent Review Tool

Tracking issue: [#39](https://github.com/DevenDucommun/agentops-workbench/issues/39)

Purpose: freeze the practical contract and publish a stable public release.

Scope:

- Document schema, CLI, config, report, and adapter compatibility policies.
- Verify migrations from known pre-1.0 database schemas.
- Finalize supported adapter matrix and unsupported transcript boundaries.
- Full release archive and package sanity checks.
- Fresh clone demo completed in under five minutes.
- Final public privacy review: no tracked local DBs, raw transcripts, private
  PAI data, local personal paths, or secrets.
- `v1.0.0` release notes that explain what is stable and what remains
  experimental.

Exit criteria:

- `bun run ci` passes on `main`.
- Fresh clone smoke passes from a clean checkout.
- Package/archive smoke passes from the published release artifact.
- Public-readiness scan and platform secret scanning are clean.
- Supported adapters ingest their documented synthetic fixtures.
- Session report, repo report, GitHub-format repo report, JSON export, and
  dashboard check all pass documented smoke commands.
- README, CLI docs, installation docs, packaging docs, dashboard docs, PAI docs,
  and Spec Kit artifacts agree on what is supported.

Dependencies:

- All pre-1.0 milestones closed or explicitly deferred.
- No unresolved privacy or release-blocking issues.

## Backlog Beyond 1.0

These are intentionally outside the 1.0 commitment:

- Hosted service or team account model.
- Multi-user auth and organization-level policy management.
- LLM-as-judge scoring.
- Live agent control or intervention.
- Direct private memory-store ingestion.
- Raw Claude Code transcript-file parsing.
- Binary distribution for users without Bun.
- Deep trace visualization comparable to a full observability platform.

## Historical Milestones

### v0.5.0

Delivered:

- Native Claude Code `claude -p --output-format stream-json` adapter and
  synthetic fixture coverage.
- Dashboard filtering and tool-map polish.
- Npm source package strategy and package dry-run smoke.

### v0.4.0

Delivered:

- Native Codex `codex exec --json` adapter and synthetic fixture coverage.
- Claude Code stream JSON fixture research and public-safe fixture decision.
- Dashboard MCP/tool usage map backed by SQLite.
- Release archive smoke script for validating GitHub source archives.

### v0.3.0

Delivered:

- Native Claude Code transcript research and fixture design.
- Native Codex transcript research and fixture design.
- Token/cost reporting model for sources that provide usage metadata.
- Local dashboard foundation backed by the existing SQLite store.
- Install/package strategy beyond local `./bin/agentops`.

### v0.2.0

Delivered:

- Versioned normalized event schema.
- Adapter contract and fixture format.
- Canonical `agentops-event-v1` JSONL documentation.
- Redaction pipeline before persistence.
- Source metadata without private path leakage.
- Parser tests for malformed, partial, and mixed event streams.
- Store migration strategy.

### v0.1.0

Delivered:

- TypeScript/Bun project scaffold.
- CLI entrypoint.
- Synthetic JSONL fixture.
- SQLite local store.
- Markdown report generation.
- Basic risk/evidence checks.
- Public planning docs and Spec Kit artifacts.
- Git ignore rules for local data and private agent folders.
- Public repo readiness, license, security policy, contribution guide, CI, and
  release notes.
