# Research And Landscape

Last reviewed: 2026-06-29.

## Summary

The agent observability space is converging around traces, spans, evaluations, cost/latency monitoring, feedback, dashboards, and OpenTelemetry compatibility. The strongest public wedge for AgentOps Workbench is narrower: local-first, repo-aware auditability for coding-agent sessions.

AgentOps Workbench should not compete head-on with full LLM observability platforms. It should produce the artifact engineering teams need before trusting AI-authored code: a deterministic audit report that ties agent actions to repository impact and verification evidence.

## Market And Developer Direction

### LangSmith

LangSmith positions observability around instrumenting LLM applications, investigating traces, and monitoring production performance. Its docs emphasize traces, dashboards, alerts, automations, user feedback, online evaluations, and deployment options.

Implication: LangSmith is broad application observability. AgentOps Workbench should integrate with this mental model but stay focused on local coding-agent transcripts, repo risk, and PR evidence.

Source: https://docs.langchain.com/langsmith/observability

### Langfuse

Langfuse describes itself as an open-source AI engineering platform for debugging, analyzing, and iterating on LLM applications. It highlights traces for LLM and non-LLM calls, sessions, timelines, user/cost tracking, agent graphs, dashboards, prompt management, and evaluations. It also emphasizes OpenTelemetry compatibility to reduce vendor lock-in.

Implication: Open-source and self-hostable observability is already well covered. AgentOps Workbench should avoid generic trace hosting and instead provide a coding-agent audit layer that can export to or align with OpenTelemetry later.

Source: https://langfuse.com/docs

### Arize Phoenix

Phoenix focuses on AI observability and evaluation. Its docs emphasize traces for individual runs, model calls, retrieval, tool use, custom logic, OpenTelemetry ingestion, OpenInference instrumentation, evals, human labels, datasets, experiments, and prompt iteration.

Implication: Phoenix validates the importance of trace + eval workflows. AgentOps Workbench should borrow the "trace plus evidence" pattern, but its evals should initially be deterministic coding-workflow checks rather than general LLM-as-judge scoring.

Source: https://arize.com/docs/phoenix

### OpenTelemetry GenAI Semantic Conventions

OpenTelemetry has moved GenAI semantic conventions into a dedicated repository covering spans, metrics, events, GenAI clients, MCP, and provider-specific conventions.

Implication: AgentOps Workbench should design its normalized event schema so future OTLP export is possible. It does not need full OTLP support in MVP, but event names and attributes should avoid painting the project into a proprietary corner.

Sources:

- https://opentelemetry.io/docs/specs/semconv/gen-ai/
- https://github.com/open-telemetry/semantic-conventions-genai

## Differentiation

AgentOps Workbench is differentiated when it answers coding-agent questions that generic LLM observability does not prioritize:

- Which repository files changed?
- Which commands ran, with what status?
- Did tests, lint, typecheck, or build actually run?
- Did the agent claim success without evidence?
- Did it touch secrets, credentials, deployment files, permission bits, generated files, or large file churn?
- Is there a PR-ready audit report?
- Can a team review this locally without uploading transcripts?

## Product Stance

Build a local workbench first, not a hosted tracing platform.

The public story is: "AgentOps Workbench turns coding-agent sessions into reviewable engineering evidence."

## Post-1.0 Research Update

The post-1.0 roadmap should prioritize real capture and decision-quality
review over generic observability breadth.

### Codex

Codex exposes useful capture and integration surfaces for AgentOps:

- `codex exec --json` for machine-readable non-interactive runs.
- Hook lifecycle events for local validation, logging, and policy scripts.
- MCP configuration for connecting tools and context.

Implication: AgentOps should add `agentops capture codex` and Codex hook
templates before pursuing hosted or broad trace export work.

Source: https://developers.openai.com/codex/codex-manual.md

### Claude Code

Claude Code documents stream output and hook surfaces that can produce bounded
local artifacts.

Implication: AgentOps should add `agentops capture claude` and opt-in Claude
Code hook templates that write sanitized local JSONL envelopes.

Sources:

- https://docs.anthropic.com/en/docs/claude-code/cli-reference
- https://docs.anthropic.com/en/docs/claude-code/hooks

### MCP

MCP is a good future integration layer because it is designed around connecting
agents to external tools and context with explicit user consent and tool
boundaries.

Implication: AgentOps should consider a read-only MCP server for recent
sessions, reports, and quality-gate results after capture and dashboard
workflows are stronger.

Sources:

- https://modelcontextprotocol.io/docs/getting-started/intro
- https://modelcontextprotocol.io/specification/2025-06-18

### Decision Dashboard

The next dashboard step should not be generic trace browsing. Existing
observability products already cover traces, spans, evaluations, dashboards,
prompt workflows, and production monitoring.

AgentOps should instead answer:

- Is the final claim supported by evidence?
- Are high-risk files or commands involved?
- What verification is missing?
- What changed compared with a previous run?
- Is this ready to attach to a PR or CI check?

This keeps AgentOps differentiated as a local repo-aware decision layer.

## Source Notes

The sources above were reviewed from official documentation or official project repositories on 2026-06-27 and refreshed on 2026-06-29. The landscape is moving quickly, so major roadmap decisions should be rechecked before implementation milestones start.
