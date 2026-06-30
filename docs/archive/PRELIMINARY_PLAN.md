# Preliminary Plan

## Product Thesis

AI coding agents are moving from personal productivity tools into engineering workflows. The missing layer is operational visibility: teams need to know what agents did, whether the result is supported by evidence, and whether the workflow introduced risk.

AgentOps Workbench should make agent work reviewable.

## Target User

Primary user:

- Staff TPM, engineering manager, developer productivity engineer, or platform engineer evaluating AI-agent adoption.

Secondary user:

- Individual developer using Claude Code, KAI, Cursor, Codex, or similar tools who wants session history and quality checks.

## Use Cases

1. Review a completed agent task before trusting the output.
2. Generate an audit report for an AI-authored pull request.
3. Identify risky commands, sensitive file edits, and missing verification.
4. Compare agent runs across task types.
5. Build a dataset of real agent failure modes.

## Architecture

```
session artifacts
    |
    v
ingestion adapters
    |
    v
normalized event model
    |
    v
sqlite store
    |
    +--> rule-based analyzers
    |
    +--> markdown report generator
    |
    +--> future dashboard/API
```

## Data Model Sketch

Core entities:

- `sessions`
- `events`
- `tool_calls`
- `commands`
- `file_changes`
- `checks`
- `risk_flags`
- `reports`

Event types:

- `message`
- `plan`
- `tool_call`
- `command`
- `file_read`
- `file_write`
- `test_run`
- `error`
- `retry`
- `final_response`

## MVP Milestones

### Milestone 0: Repo Setup

- Create TypeScript/Bun project
- Add lint/test scripts
- Add SQLite dependency
- Add sample fixture folder
- Add project README and architecture notes

### Milestone 1: Transcript Ingestion

- Define normalized event schema
- Implement Claude/KAI transcript parser
- Parse one real session fixture
- Store session/events in SQLite
- Add tests for parser edge cases

### Milestone 2: Report Generation

- Generate Markdown session report
- Include files touched, commands run, and major timeline
- Identify final response and claimed verification
- Add report snapshot tests

### Milestone 3: Risk And Evidence Checks

- Flag destructive shell commands
- Flag writes to sensitive paths
- Flag secret-looking output
- Detect whether tests/lint were run
- Detect "claimed success without evidence"

### Milestone 4: PR/Repo Mode

- Summarize agent work against current git diff
- Map file changes to agent events
- Generate PR-review-ready report

### Milestone 5: Dashboard

- Local web UI
- Session list
- Timeline view
- Risk/evidence cards
- File/command drilldown

## First Implementation Slice

Build this first:

```bash
agentops ingest ./fixtures/sample-session.jsonl
agentops report --session latest > report.md
```

The output should be useful even before the dashboard exists.

## Quality Bar

- No secrets committed in fixtures
- Parser fixtures are sanitized
- Reports are deterministic
- Tests cover malformed events
- Tool should work offline
- Local data stays local by default

## Open Questions

- What exact Claude/KAI session artifact format should be the first supported source?
- Should the first fixture come from KAI, Claude Code, Codex, or a synthetic transcript?
- Should reports include token/cost only when available, or estimate from transcript text?
- Should this project integrate directly with KAI hooks later, or remain post-hoc only?
