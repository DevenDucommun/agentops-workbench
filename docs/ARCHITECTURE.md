# Architecture

## Goal

AgentOps Workbench ingests coding-agent session artifacts, normalizes them into a stable local event model, analyzes risk and evidence, stores the result in SQLite, and emits reviewable reports.

## System Context

```text
agent transcript / hook events / exported logs
        |
        v
ingestion adapter
        |
        v
normalized event stream
        |
        +--> SQLite local store
        |
        +--> analyzers
        |      - risk flags
        |      - verification evidence
        |      - loop/stall detection
        |      - cost/token extraction
        |
        +--> outputs
               - Markdown session report
               - PR/repo report
               - future dashboard/API
               - future OTLP/OpenTelemetry export
```

## Core Modules

### CLI

The CLI is the primary interface through MVP.

Initial commands:

- `agentops ingest <session.jsonl>`
- `agentops report --session latest`
- `agentops report --session <id>`

Planned commands:

- `agentops inspect <session>`
- `agentops scan-publication`
- `agentops repo-report`
- `agentops export --format markdown|json|otlp`
- `agentops doctor`

### Ingestion Adapters

Adapters parse runner-specific artifacts into the normalized event model.

Initial adapter:

- `jsonl`: synthetic/sanitized session fixture format for stable tests.

Candidate adapters:

- Claude Code exported session logs.
- KAI session artifacts, if the format is safe to document publicly.
- Codex/Codex-like transcripts.
- Hook-stream adapter for real-time capture.

Adapter rules:

- No analyzer logic inside adapters.
- Preserve raw event JSON only when safe or explicitly redacted.
- Attach source metadata without exposing local paths in public reports.

### Normalized Event Model

Minimum event types:

- `message`
- `plan`
- `tool_call`
- `command`
- `file_read`
- `file_write`
- `file_edit`
- `test_run`
- `error`
- `retry`
- `final_response`

Core event attributes:

- session id
- sequence index
- timestamp when available
- event type
- role
- summary
- source adapter
- raw payload hash
- optional redacted raw payload

### SQLite Store

The local database stores normalized sessions and analysis outputs.

Core tables:

- `sessions`
- `events`
- `tool_calls`
- `commands`
- `file_changes`
- `checks`
- `risk_flags`
- `reports`
- `costs`

MVP already has:

- `sessions`
- `events`
- `commands`
- `file_changes`
- `risk_flags`

### Analyzer Pipeline

Analyzer passes should be deterministic and composable:

- command risk analyzer
- file risk analyzer
- verification analyzer
- final-claim analyzer
- secret-looking value analyzer
- churn analyzer
- retry/loop analyzer
- generated-file analyzer
- cost/token analyzer

Each analyzer should emit structured findings:

- severity
- category
- message
- related event id
- confidence
- remediation hint

### Report Generator

Markdown remains the primary output because it can be reviewed in terminals, PR comments, GitHub issues, and docs.

Report sections:

- session summary
- timeline
- files touched
- commands run
- tests and verification evidence
- risk flags
- stalls/retries/loops
- cost/token summary when available
- final outcome assessment
- appendices for raw metadata hashes

### Dashboard

The dashboard is a later layer over the local store. It should not drive schema design before the CLI/report workflow is proven.

Dashboard views:

- session list
- timeline
- file/command drilldown
- risk/evidence cards
- tool/MCP map
- trend view across sessions

## PAI Integration Boundary

PAI should be treated as an optional local integration, not a dependency.

Public architecture language:

- AgentOps Workbench can ingest sanitized local agent-session artifacts produced by a personal assistant or agent runtime.
- A PAI adapter may read exported session artifacts or hook envelopes only when the user explicitly opts in.
- The workbench must never require access to private memory stores, credential stores, relationship stores, raw learning stores, security stores, identity stores, or failure-capture stores.

Integration modes:

1. Post-hoc import: PAI or another agent exports a sanitized session artifact; AgentOps ingests it.
2. Hook mirror: PAI emits bounded event envelopes into an AgentOps-compatible JSONL stream.
3. Report handoff: AgentOps produces Markdown/JSON reports that PAI can summarize later.

Preferred initial mode: post-hoc import.

Reasons:

- least invasive
- easiest to sanitize
- easy to explain publicly
- does not couple product viability to a private PAI deployment

## Public Data Boundary

Never commit:

- raw personal transcripts
- private PAI memory
- local absolute paths
- account names
- email addresses
- API keys or tokens
- raw command output from real systems
- private repo names unless intentionally public
- screenshots containing private terminal context

Commit only:

- synthetic fixtures
- redacted fixtures
- schema examples
- public docs
- generated example reports from synthetic data

## Future OpenTelemetry Alignment

AgentOps Workbench should map internal event names to OpenTelemetry/GenAI concepts where practical:

- session -> trace/session concept
- tool call -> span/event
- command -> custom span/event
- file change -> repo-domain event
- risk flag -> event/attribute or separate finding
- token/cost -> metrics

MVP does not need OTLP export, but the schema should keep stable identifiers and timestamps so export can be added later.
