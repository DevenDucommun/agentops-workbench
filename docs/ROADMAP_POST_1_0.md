# Roadmap After 1.0

Status: proposed post-`v1.0.0` roadmap.

Last reviewed: 2026-06-29.

## Product Direction

AgentOps Workbench should stay narrow and useful: a local-first way to decide
whether an AI coding-agent run is trustworthy enough to review, merge, or hand
off.

The post-1.0 roadmap has three product bets:

- Real capture integrations where agent work already happens.
- Decision-quality reports and dashboard views for code review and merge
  readiness.
- Distribution and CI paths that make adoption boring for external users.

This avoids competing head-on with full LLM observability platforms. AgentOps
should complement trace platforms by producing repo-aware engineering evidence.

## Research Signals

Current public docs and tool direction point to these conclusions:

- Codex supports machine-readable non-interactive execution through
  `codex exec --json`, plus hooks and MCP integration surfaces. This makes
  Codex capture and hook templates a strong near-term target.
- Claude Code supports machine-readable stream output and hook events. This
  makes Claude Code capture and hook templates a strong near-term target.
- MCP is becoming the common way to expose tools and local context to agents.
  AgentOps should provide a small MCP server for safe report/session lookup
  before attempting deeper live control.
- LangSmith, Langfuse, and Phoenix validate the trace/eval/dashboard category,
  but they are broader LLM observability systems. AgentOps should focus on the
  coding-agent decision layer: changed files, commands, evidence, risk, and PR
  readiness.
- OpenTelemetry GenAI conventions are worth tracking, but OTLP export should
  remain deferred until AgentOps has stronger demand for external trace export.

Reference docs:

- Codex manual: https://developers.openai.com/codex/codex-manual.md
- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
- MCP introduction: https://modelcontextprotocol.io/docs/getting-started/intro
- MCP specification: https://modelcontextprotocol.io/specification/2025-06-18
- LangSmith observability: https://docs.langchain.com/langsmith/observability
- Langfuse docs: https://langfuse.com/docs
- Phoenix docs: https://arize.com/docs/phoenix
- OpenTelemetry GenAI conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## Milestone Ladder

### v1.1.0: Real Capture Integrations

Tracking issue: [#48](https://github.com/DevenDucommun/agentops-workbench/issues/48)

Purpose: reduce friction between agent execution and AgentOps ingestion.

Scope:

- Add `agentops capture codex` for documented `codex exec --json` workflows.
- Add `agentops capture claude` for documented Claude Code stream JSON
  workflows.
- Provide safe hook templates for Codex and Claude Code that write bounded
  local JSONL envelopes.
- Add explicit capture docs for stdout/stderr separation, redaction review,
  ignored local files, and fixture sanitization.
- Expand adapter diagnostics for common native stream and hook-envelope
  failures.

Exit criteria:

- A user can run a documented Codex capture command and ingest the resulting
  artifact.
- A user can run a documented Claude Code capture command and ingest the
  resulting artifact.
- Hook templates are opt-in, local-only, and safe to inspect before enabling.
- Synthetic fixtures cover successful capture, failed command capture, missing
  usage, and unsupported-shape diagnostics.
- `bun run ci`, install smoke, package smoke, packed install smoke, dashboard
  smoke, and release archive smoke pass.

Deferred:

- Live tailing during active sessions.
- Direct private transcript parsing.
- Hosted capture.

### v1.2.0: Decision Dashboard

Tracking issue: [#49](https://github.com/DevenDucommun/agentops-workbench/issues/49)

Purpose: make the dashboard answer review and merge-readiness questions, not
just display session data.

Scope:

- Add a merge-readiness summary for one session or repo report.
- Add a claim-vs-evidence matrix for tests, lint, typecheck, build, and final
  success claims.
- Add risk severity drilldown with affected files, commands, and evidence.
- Add run comparison for two sessions or two reports from the same repo.
- Add dashboard export links for Markdown and JSON evidence bundles.
- Improve empty states and demo flow using synthetic fixtures.

Exit criteria:

- A reviewer can identify unverified claims, risky files, and missing checks in
  one screen.
- The dashboard can compare two synthetic sessions and highlight changes in
  risk, verification, files, and usage.
- Dashboard smoke covers the new decision endpoints.
- README screenshot and dashboard docs match the implemented UI.

Deferred:

- Hosted dashboard.
- Multi-user auth.
- Remote dashboard API guarantees.

### v1.3.0: Quality Gates And PR Workflow

Tracking issue: [#50](https://github.com/DevenDucommun/agentops-workbench/issues/50)

Purpose: turn AgentOps reports into repeatable local or CI checks.

Scope:

- Add configurable quality gates for required verification commands, maximum
  high-severity risks, generated-file churn, and unsupported final claims.
- Add `agentops gate --session latest` and repo-aware gate output.
- Add GitHub Action documentation or a small action wrapper for local report
  generation in CI.
- Add PR-comment body generation that includes pass/fail gate status.
- Add machine-readable gate JSON for downstream workflows.

Exit criteria:

- A repo can fail CI when an agent run lacks required evidence or crosses risk
  thresholds.
- Gate behavior is deterministic and covered by fixture tests.
- Docs explain how to use gates without uploading transcripts or raw payloads.
- GitHub-format output remains stdout-only unless a future explicit posting
  command is designed.

Deferred:

- LLM-as-judge scoring.
- Automatic PR posting by default.
- Organization policy service.

### v1.4.0: Distribution And Adoption

Tracking issue: [#51](https://github.com/DevenDucommun/agentops-workbench/issues/51)

Purpose: make AgentOps easier to install, demo, and trust outside the original
development environment.

Scope:

- Decide whether to publish an npm source package or keep clone/source-archive
  distribution.
- Add Windows support decision and CI coverage if support is claimed.
- Improve quickstart and demo path so a new user reaches a useful report and
  dashboard in under five minutes.
- Add sample release/demo artifacts generated from synthetic sessions.
- Revisit Bun standalone binary feasibility.

Exit criteria:

- Installation docs match the supported distribution path.
- Package or source-archive smoke matches the chosen distribution decision.
- Platform support claims are tested or explicitly excluded.
- Public demo data remains synthetic and passes the publication scan.

Deferred:

- Hosted SaaS packaging.
- Enterprise installer.
- Binary distribution without evidence of user demand.

## Later Candidates

These are intentionally not planned until the `v1.1.0` through `v1.4.0`
sequence proves demand:

- AgentOps MCP server for read-only session/report lookup.
- OpenTelemetry or OpenInference export.
- LLM-as-judge evaluation backed by deterministic evidence.
- Team policy packs.
- Hosted dashboard.
- Direct integrations with issue trackers or incident tools.
- Live intervention in active agent runs.

## Current Non-Goals

- Reading private PAI memory stores.
- Publishing raw transcripts as fixtures.
- Uploading local session data to hosted services by default.
- Parsing undocumented private transcript files as a stable feature.
- Replacing LangSmith, Langfuse, Phoenix, or other full observability systems.
