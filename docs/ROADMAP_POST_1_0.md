# Roadmap After 1.0

Status: `v1.9.0` complete; later milestones proposed.

Last reviewed: 2026-06-30. Updated for the completed quality-gates milestone.

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
- Local CLI validation on 2026-06-30 confirmed current Codex exposes
  `codex exec --json` and current Claude Code exposes
  `claude -p --output-format stream-json --verbose`. These are the reliable
  full-fidelity capture modes for AgentOps.
- Plain terminal output, copied chat text, and final-answer-only output are
  weaker audit sources. They can support retrospective triage, but they need
  explicit confidence/provenance labels so inferred evidence is not presented
  as observed tool or command evidence.
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

Status: complete in `v1.1.0`.

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

Status: complete in `v1.2.0`.

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

### v1.3.0: Simplified Capture And Import UX

Tracking issue: [#50](https://github.com/DevenDucommun/agentops-workbench/issues/50)

Status: complete in `v1.3.0`.

Purpose: make the normal user path understandable without requiring users to
know adapter names, SQLite, JSONL internals, or shell redirection.

Scope:

- Add `agentops run codex <prompt>` and `agentops run claude <prompt>` as the
  recommended live capture entrypoints.
- Add `agentops review [latest|session-id]` as the default post-capture review
  command.
- Add `agentops import <artifact>` as the user-facing retrospective command,
  keeping `agentops ingest` as a compatibility alias.
- Add `--out <file>` support to report, repo-report, export, and review
  commands so users do not need shell redirection for common outputs.
- Improve diagnostics for common mistakes, including passing `.agentops` SQLite
  databases to import/ingest or typing an output filename as a command.
- Update README, CLI docs, and capture guide around two modes:
  live capture with `agentops run`, and after-the-fact audit with
  `agentops import`.
- Make the README explicit that reliable retrospective audit requires provider
  machine-readable artifacts:
  `codex exec --json ...` or
  `claude -p --output-format stream-json --verbose ...`.

Exit criteria:

- A first-time user can run, review, export, and open the dashboard without
  learning the SQLite store or adapter internals.
- Existing `capture`, `ingest`, `inspect`, `report`, `repo-report`, and
  `export` commands remain compatible.
- CLI tests cover simplified commands and common user mistakes.
- README and CLI docs explain when AgentOps must be in the command path and
  when after-the-fact audit is possible.
- Public-readiness scan and CI pass.

Deferred:

- Plain terminal transcript ingestion.
- Direct private transcript-store parsing.
- Quality gates and CI policy checks.

### v1.4.0: Retrospective And Forensic Import

Tracking issue: [#51](https://github.com/DevenDucommun/agentops-workbench/issues/51)

Status: complete in `v1.4.0`. The implementation keeps the workflow simple by
extending `agentops import <artifact>` with a `forensic-text` adapter instead
of adding a separate forensic command.

Purpose: let users audit what they already have, including lower-fidelity plain
terminal transcripts, without pretending inferred evidence is as strong as
native JSONL evidence.

Scope:

- Add a best-effort plain-text transcript adapter for saved Claude/Codex
  terminal output.
- Detect likely commands, command status lines, file paths, final claims,
  provider markers, and obvious verification evidence from plain text.
- Add evidence provenance/confidence labels such as `observed`, `inferred`,
  and `missing`.
- Add report/dashboard language that distinguishes full-fidelity JSONL capture
  from forensic plain-text import.
- Add synthetic fixtures for Codex final-output-only text, Claude text output,
  command-rich terminal logs, and weak copied-chat transcripts.
- Add diagnostics that tell users when a transcript is too weak for meaningful
  audit and suggest rerunning with `agentops run` or provider JSONL mode.
- Document privacy risks for importing real terminal logs, including shell
  prompts, local paths, environment output, and copied secrets.

Exit criteria:

- `agentops import transcript.txt` produces a useful report for command-rich
  synthetic plain-text logs.
- Final-answer-only transcripts are accepted only as low-confidence audits with
  clear missing-evidence flags.
- Reports and dashboard views never merge inferred evidence with observed
  command/tool evidence without labeling it.
- Fixture tests cover positive, weak, and unsupported transcript cases.
- Docs make clear that native JSONL remains the recommended source for
  full-fidelity audit.

Deferred:

- Private Claude/Codex transcript-store scraping.
- OCR/screenshot transcript import.
- LLM-based reconstruction from arbitrary chat logs.
- Quality gates and CI policy checks.

### v1.5.0: Quality Gates And PR Workflow

Status: complete in `v1.5.0`.

Purpose: turn AgentOps reports into repeatable local or CI checks once capture
and import semantics are clear.

Scope:

- Add configurable quality gates for required verification commands, maximum
  high-severity risks, generated-file churn, and unsupported final claims.
- Add `agentops gate [latest|session-id]` with repo-aware gate output.
- Add GitHub Actions documentation for local report generation in CI.
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

### v1.6.0: Distribution And Adoption

Status: complete in `v1.6.0`.

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

### v1.7.0: Guided First-Run Simplification

Tracking issue: [#79](https://github.com/DevenDucommun/agentops-workbench/issues/79)

Status: complete in `v1.7.0`.

Purpose: reduce first-use decision load by making setup checks, synthetic demos,
artifact audits, and PR-ready reports reachable through short guided commands.

Scope:

- Add `agentops doctor` for local readiness checks and recommended next steps.
- Add `agentops demo` for a one-command synthetic demo import path.
- Add `agentops audit <artifact>` for import, review, and quality gate in one
  command.
- Add `agentops pr` as a short GitHub-ready repo report command.
- Simplify top-level help and empty-session guidance.

Exit criteria:

- Guided commands are covered by CLI tests.
- Install/package/archive smokes exercise the guided path.
- README, CLI docs, and installation docs lead with the simplified path.
- Existing advanced commands remain compatible.

Deferred:

- Hosted onboarding.
- Automatic provider login or credential setup.
- Posting PR comments directly to GitHub.

### v1.8.0: Guided Setup Automation

Status: complete in `v1.8.0`.

Purpose: remove the remaining local setup chores from the first-run path while
keeping setup changes explicit, safe, and local.

Scope:

- Add `agentops init` to create `.agentops/`, ensure `.agentops/` is ignored,
  write a default config when missing, run readiness checks, and print one
  next command.
- Add `agentops doctor --fix` for the same safe local setup fixes before
  readiness checks.
- Add `agentops demo --serve` to import synthetic demo sessions and start the
  local dashboard.
- Update quickstart and installation docs to lead with `agentops init`.

Exit criteria:

- Setup commands are covered by CLI tests.
- Existing config is not overwritten.
- Provider credentials and login state remain out of scope.

### v1.9.0: Read-Only MCP Server

Status: complete in `v1.9.0`.

Purpose: let compatible local agents query AgentOps evidence without scraping
private files or requiring hosted services.

Scope:

- Add `agentops mcp` as a stdio MCP server.
- Expose read-only tools for session listing, session inspection, session
  reports, quality gates, and repo reports.
- Keep ingest, capture, provider execution, GitHub posting, and private
  transcript-store access out of the MCP surface.
- Document MCP client configuration, tool names, and privacy boundaries.

Exit criteria:

- MCP initialize, tool listing, and tool calls are covered by tests.
- Tools use the existing local SQLite store, report, and gate logic.
- No MCP tool mutates sessions or reads private transcript stores.

## Later Candidates

These are intentionally not planned until the `v1.1.0` through `v1.9.0`
sequence proves demand:

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
