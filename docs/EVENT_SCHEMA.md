# AgentOps Event Schema

Current schema version: `agentops.event.v1`

AgentOps Workbench uses JSONL as its first interchange format. Each line is one JSON object. The first record should be a `session` record, followed by event records.

`agentops.event.v1` is stable in `v1.0.0`. Compatible changes may add optional
fields, but breaking changes require a new major version or migration path. See
[Compatibility policy](COMPATIBILITY.md).

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

## Chain And Provenance Fields

These optional event fields support the forensic recorder (see
[forensic recorder spec](specs/forensic-recorder/spec.md), R1.5). Every
existing input stays valid without them, and current reports ignore them.

| Field | Type | Meaning |
| --- | --- | --- |
| `eventId` | string | Stable ID, unique within the session. The recorder writes `<sessionId>:<seq>`. Not the SQLite row id that reports and exports call `id` or `eventId` |
| `seq` | integer | Position in the session's chain, starting at 1 |
| `prevHash` | string or `null` | `hash` of the previous record; `null` on the first record (`seq` 1) |
| `hash` | string | sha256 hex of the record's canonical JSON with `hash` itself removed |
| `cwd` | string | Working directory when the event happened (redacted like other local paths) |
| `gitHead` | string | Commit SHA at HEAD, when known |
| `toolUseId` | string | Provider tool-call ID that pairs a call with its result |
| `parentToolUseId` | string | Tool-call ID of the enclosing subagent call, for events inside a subagent |
| `agentId` | string | Subagent ID, for events inside a subagent |
| `contentHash` | string | sha256 hex of the file content written by a write or edit |

```json
{
  "schemaVersion": "agentops.event.v1",
  "type": "command",
  "input": { "cmd": "bun test" },
  "exitCode": 0,
  "eventId": "s:1",
  "seq": 1,
  "prevHash": null,
  "hash": "339d99d67e42f51bf0e7e38d10170359e226f9232e975fbfaa6c78d5f1f6644b"
}
```

**Canonical JSON** (`src/eventChain.ts`): object keys sorted by UTF-16 code
unit at every level, no whitespace, and strings and numbers serialized as
`JSON.stringify` does. For plain JSON values this matches RFC 8785 (JCS).
Undefined members are dropped. Non-finite numbers are rejected.

**Chain rules.** `prevHash` and `seq` are part of the hashed content, so
editing, removing or reordering a record breaks every later link. A session
whose events carry no chain fields is `unchained` (legacy), not broken.
Verification (`agentops verify`) is planned for M4.

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

Portable session/repo JSON exports use `agentops.export.v1`, documented in
[JSON export](EXPORT.md).

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

## Standards Mapping (OpenTelemetry / GenAI)

AgentOps provides deterministic local JSON exports (`agentops.export.v1` and the
OpenInference-style `agentops.openinference.v1`). OTLP/protobuf export and
collector upload remain deferred until a concrete integration need appears — the
local JSON export suits the CLI-first workflow, and GenAI conventions may still
evolve. A future exporter should transform AgentOps exports rather than read
private transcripts directly.

| AgentOps field | Trace-like concept | Notes |
| --- | --- | --- |
| `session.id` | trace id / attribute | External session id, not necessarily a valid OTLP trace id. |
| `events[].id` / `events[].idx` | span id / order | IDs are local SQLite IDs; `idx` is stable session order. |
| `events[].type` | span / event name | `tool_call`, `file_edit`, `final_response`, ... |
| `commands[]` | tool execution span | command, status, exit code, redacted output summary. |
| `files[]` | code/file change event | path, operation, churn. |
| `tools[]` | tool usage aggregate | dashboard summaries. |
| `usage.inputTokens` / `outputTokens` | GenAI token counts | availability depends on adapter. |
| `usage.costAmount` | cost attribute | currency travels with the amount. |
| `risks[]` | analysis finding | severity / category / message map to finding attributes. |
| `verification[]` | evidence event / span | captures tests / lint / typecheck / build evidence. |
