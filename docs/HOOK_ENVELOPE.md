# Hook Envelope JSONL

This is the proposed sanitized hook-envelope format for future local capture.
It is documented in `v0.8.0`; live hook capture remains deferred.

## Goals

- Provide a bounded event shape for PAI/KAI-style local orchestrators.
- Avoid reading private memory stores.
- Redact before writing hook events.
- Keep each record independently reviewable as JSONL.

## Envelope

Each line is one JSON object:

```json
{
  "schemaVersion": "agentops.hook-envelope.v1",
  "sessionId": "synthetic-session",
  "sequence": 1,
  "source": "local-agent",
  "capturedAt": "2026-06-28T00:00:00Z",
  "event": {
    "schemaVersion": "agentops.event.v1",
    "type": "tool_call",
    "toolName": "shell",
    "input": {
      "cmd": "bun test"
    },
    "status": "completed",
    "exitCode": 0
  }
}
```

## Rules

- `event` must be valid `agentops.event.v1`.
- Redaction must happen before writing the envelope.
- Hook captures should be written to ignored local paths such as
  `.agentops/captures/`.
- Raw private memory, credentials, local account data, and full unreviewed
  transcript content are not allowed.
- Capture failures should not block the agent run unless explicitly configured
  by the user.

## Status

This format is a documented compatibility target. AgentOps does not yet tail or
write hook envelopes directly.
