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
