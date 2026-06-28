# AgentOps Event Schema

Current schema version: `agentops.event.v1`

AgentOps Workbench uses JSONL as its first interchange format. Each line is one JSON object. The first record should be a `session` record, followed by event records.

## Session Record

```json
{
  "schemaVersion": "agentops.event.v1",
  "type": "session",
  "id": "example-session",
  "source": "pai",
  "agent": "local-agent",
  "model": "model-or-runtime-name",
  "repo": "repo-name",
  "task": "Short task description",
  "startedAt": "2026-06-27T21:00:00Z",
  "endedAt": "2026-06-27T21:04:00Z"
}
```

Required fields:

- `schemaVersion`
- `type`
- `id`

Recommended fields:

- `source`
- `agent`
- `model`
- `repo`
- `task`
- `startedAt`
- `endedAt`
- `usage`

## Event Records

Common fields:

- `schemaVersion`
- `type`
- `source`
- `timestamp`
- `role`
- `content`
- `summary`
- `status`
- `usage`

Supported MVP event types:

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

## Tool Or Command Event

```json
{
  "schemaVersion": "agentops.event.v1",
  "type": "tool_call",
  "source": "pai",
  "toolName": "shell",
  "input": {
    "cmd": "bun test"
  },
  "status": "completed",
  "exitCode": 0,
  "output": "4 pass\n0 fail"
}
```

## File Edit Event

```json
{
  "schemaVersion": "agentops.event.v1",
  "type": "file_edit",
  "source": "pai",
  "path": "src/cli.ts",
  "operation": "edit",
  "linesAdded": 6,
  "linesRemoved": 1,
  "summary": "Added a synthetic CLI option."
}
```

## Usage Metadata

Usage metadata is optional. Sources that provide token or cost data can attach a `usage` object to the session record. If no session-level usage is present, AgentOps can derive totals from event-level `usage` objects.

```json
{
  "schemaVersion": "agentops.event.v1",
  "type": "session",
  "id": "usage-example",
  "usage": {
    "inputTokens": 1200,
    "outputTokens": 340,
    "totalTokens": 1540,
    "cost": {
      "amount": 0.0142,
      "currency": "USD"
    }
  }
}
```

Supported usage fields:

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `costAmount`
- `costCurrency`
- `costUsd`
- `totalCost`
- `cost.amount`
- `cost.currency`

If `totalTokens` is omitted but input/output token counts are present, AgentOps derives the total.

## Privacy Rules

Public fixtures should be synthetic or redacted. Do not include:

- raw private transcripts
- private PAI memory
- secrets or credentials
- local absolute paths
- account identifiers
- private repository names
- raw command output from real systems

By default, AgentOps stores raw payload hashes but does not store raw payload JSON.

## Fixture Coverage

Committed fixtures are synthetic and cover:

- normal canonical JSONL: `fixtures/sample-session.jsonl`
- PAI post-hoc export JSONL: `fixtures/pai-export-session.jsonl`
- Claude Code sanitized export JSONL: `fixtures/claude-code-session.jsonl`
- Claude Code native stream JSONL: `fixtures/claude-code-stream-session.jsonl`
- Codex sanitized export JSONL: `fixtures/codex-session.jsonl`
- Codex native exec JSONL: `fixtures/codex-exec-session.jsonl`
- usage metadata: `fixtures/usage-session.jsonl`
- missing timestamps: `fixtures/missing-timestamps-session.jsonl`
- risky commands/files: `fixtures/risky-session.jsonl`
- malformed JSONL: `fixtures/malformed-session.jsonl`
