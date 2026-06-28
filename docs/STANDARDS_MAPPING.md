# Standards Mapping

This document maps AgentOps Workbench concepts to trace-like observability
concepts and OpenTelemetry/GenAI-style fields.

## Status

Status for `v1.0.0`: documented mapping only. OTLP export remains deferred
until a concrete integration need appears.

Reason:

- The local JSON export is more useful for the current CLI-first workflow.
- OpenTelemetry GenAI conventions may evolve.
- A premature OTLP exporter would freeze field choices before the AgentOps
  schema is stable enough.

## Mapping

| AgentOps field | Trace-like concept | Notes |
| --- | --- | --- |
| `session.id` | trace id or trace attribute | Use as an external session identifier, not necessarily a valid OTLP trace id. |
| `events[].id` / `events[].idx` | span id/order | Event IDs are local SQLite IDs. `idx` is the stable session order. |
| `events[].type` | span name or event name | Examples: `tool_call`, `file_edit`, `final_response`. |
| `commands[]` | tool execution span | Include command, status, exit code, and redacted output summary. |
| `files[]` | code/file change event | Include path, operation, and churn. |
| `tools[]` | tool usage aggregate | Useful for dashboard summaries, less useful as raw spans. |
| `usage.inputTokens` | GenAI input token count | Source availability depends on adapter. |
| `usage.outputTokens` | GenAI output token count | Source availability depends on adapter. |
| `usage.costAmount` | cost attribute | Currency must travel with the amount. |
| `risks[]` | analysis finding event | Severity/category/message map to finding attributes. |
| `verification[]` | evidence event/span | Captures tests/lint/typecheck/build evidence. |

## Export Decision

`agentops.export.v1` is the canonical portable format in `v1.0.0`.

OTLP export is deferred. A future exporter should transform
`agentops.export.v1` rather than reading private transcript artifacts directly.
