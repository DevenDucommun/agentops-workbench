# PAI Integration Plan

## Purpose

AgentOps Workbench should fit alongside a personal AI deployment without becoming coupled to it. The public project should describe generic integration surfaces while keeping private PAI deployment details outside the repository.

## Current Understanding

The local PAI Codex plugin available in this environment is read-only and bounded. It is designed to provide approved project memory and confirmed lessons to Codex, with no default hook injection enabled in the plugin metadata observed during review.

Publicly safe conclusions:

- PAI can be treated as one possible local agent context source.
- AgentOps should not require PAI.
- AgentOps should not read private PAI memory stores.
- AgentOps can consume sanitized exported session artifacts produced by PAI or any other local agent runtime.

Private details intentionally excluded:

- memory contents
- private data roots
- private deployment paths
- credential locations
- relationship, identity, security, raw learning, or failure-capture stores

## Integration Modes

### Mode 1: Post-Hoc Import

PAI exports a sanitized session artifact after an agent run. AgentOps ingests the artifact.

This is the recommended first integration because it is easiest to sanitize and easiest to describe publicly.

Expected artifact:

```json
{"type":"session","id":"example","agent":"local-agent","task":"Implement feature"}
{"type":"message","role":"user","content":"Redacted or synthetic prompt"}
{"type":"tool_call","toolName":"shell","input":{"cmd":"bun test"},"status":"completed","exitCode":0}
{"type":"file_edit","path":"src/example.ts","operation":"edit","linesAdded":8,"linesRemoved":2}
{"type":"final_response","role":"assistant","content":"Summary of completed work"}
```

### Mode 2: Hook Mirror

PAI or another runtime writes bounded event envelopes to a JSONL file during a session. AgentOps ingests the stream after the run or tails it in a later version.

Requirements:

- redaction before writing
- no raw private memory content
- stable session id
- bounded payload size
- explicit user opt-in

### Mode 3: Report Handoff

AgentOps produces Markdown or JSON reports that PAI can use later as project context.

Requirements:

- reports generated from sanitized data
- no local absolute paths by default
- no secret-looking values

## Non-Goals

- Directly reading PAI private memory stores.
- Modifying PAI memory.
- Publishing PAI internals.
- Making PAI a required dependency.
- Shipping credentials, tokens, or user-specific config.

## Adapter Contract

A future PAI adapter should implement the same ingestion contract as every other adapter:

- input: file path, stream, or exported artifact
- output: normalized event stream
- behavior: deterministic, tested, redacted
- errors: structured parse diagnostics

## Open Questions

- What sanitized PAI export format is easiest to produce without touching private memory stores?
- Should the adapter live in core or as an optional package?
- Should hook mirroring write directly to AgentOps JSONL, or should it use a separate PAI envelope that AgentOps adapts?
- What redaction policy should run before writing hook events?
