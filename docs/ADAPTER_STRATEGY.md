# Adapter Strategy

## Decision

AgentOps Workbench should support PAI, Claude, and Codex through the same adapter contract:

```text
source artifact
    |
    v
adapter
    |
    v
agentops event v1
    |
    v
store + analyzers + reports
```

PAI should not be treated as the canonical data model. It should be one source that can export or mirror a sanitized session artifact.

## Best Initial Shape

### 1. Canonical AgentOps JSONL

Create and document `agentops-event-v1` as the stable interchange format.

Every source eventually becomes this:

```json
{"schemaVersion":"agentops.event.v1","type":"session","id":"example","agent":"local-agent","task":"Implement feature"}
{"schemaVersion":"agentops.event.v1","type":"tool_call","toolName":"shell","input":{"cmd":"bun test"},"status":"completed","exitCode":0}
{"schemaVersion":"agentops.event.v1","type":"file_edit","path":"src/example.ts","operation":"edit","linesAdded":8,"linesRemoved":2}
{"schemaVersion":"agentops.event.v1","type":"final_response","role":"assistant","content":"Summary of completed work"}
```

### 2. PAI Post-Hoc Export

PAI exports sanitized `agentops-event-v1` JSONL after a run. AgentOps ingests that file.

MVP command:

```bash
agentops audit ./fixtures/pai-export-session.jsonl --quiet
```

This is the best first PAI integration because:

- it avoids private PAI memory stores
- it is easy to review before ingest
- it can be tested with synthetic fixtures
- it can support Claude/Codex sessions if PAI has captured or summarized them
- it does not make AgentOps depend on PAI internals

### 3. Direct Claude And Codex Adapters

Claude and Codex should also have direct adapters when their public or local artifact formats are well understood and safe to parse.

This matters because:

- users should not need PAI to use AgentOps
- direct adapters produce better source-specific metadata
- direct adapters reduce ambiguity when PAI was not involved
- adapter tests can isolate source-format changes

## Use Cases That Make The Most Sense

### Best Case 1: Developer Reviews A Local Agent Run

The developer runs Claude, Codex, or a PAI-backed workflow, exports a sanitized session, and runs:

```bash
agentops audit ./session.jsonl --quiet
agentops save report --session latest --out report.md
```

Value: immediate audit trail without uploading data.

### Best Case 2: PAI Produces A Safe Handoff Artifact

PAI does not expose memory. It exports a bounded, sanitized action log:

- user request summary
- tool calls
- shell commands
- file edits
- verification commands
- final response summary

AgentOps turns that into a risk/evidence report.

Value: PAI remains private while AgentOps gets structured evidence.

### Best Case 3: PR Review Attachment

AgentOps maps session events to repo changes and produces a PR-ready report.

Value: engineering managers and reviewers can see what the agent did and what evidence supports it.

### Best Case 4: Cross-Agent Comparison

The same normalized schema supports PAI, Claude, Codex, and future agents.

Value: reports can compare risk, verification, retries, costs, and tool use without binding to one agent vendor.

## Adapter Contract

Each adapter should expose:

- adapter id
- supported artifact hints
- parse function
- redaction behavior
- schema version emitted
- diagnostics for malformed or partial artifacts

Example:

```ts
type Adapter = {
  id: string;
  detect(input: AdapterInput): Promise<AdapterDetection>;
  parse(input: AdapterInput, options: AdapterOptions): AsyncIterable<AgentOpsEvent>;
};
```

## Source Priority

Build in this order:

1. `agentops-jsonl` canonical adapter — handles every sanitized
   `agentops.event.v1` export (synthetic fixtures, PAI/KAI, Claude Code, Codex);
   provenance lives in each record's `source` field.
2. `codex-exec-jsonl` native adapter for `codex exec --json` captures.
3. `claude-code-stream-json` native adapter for `claude -p --output-format stream-json` captures.
4. `forensic-text` best-effort adapter for saved terminal transcripts and copied coding-agent text.
5. hook-stream adapter for future live capture.

## Implemented Adapters

See [Compatibility policy](COMPATIBILITY.md) for the support matrix and
boundaries. As of `v2.0.0` the per-source export adapters
(`pai-export-jsonl`, `claude-code-jsonl`, `codex-jsonl`) are folded into
`agentops-jsonl`, since they shared one schema and parser.

The current implementation supports normalized JSONL export artifacts:

- `agentops-jsonl`: canonical `agentops.event.v1` JSONL, any `source`
  (`pai`, `claude-code`, `codex`, or none).
- `claude-code-stream-json`: native `claude -p --output-format stream-json` JSONL stream.
- `codex-exec-jsonl`: native `codex exec --json` JSONL stream.
- `forensic-text`: lower-fidelity plain terminal transcript or copied coding-agent text.

Use `agentops adapters` to list supported adapters and `agentops adapters --input <file>` to see detection diagnostics for a specific artifact.

The export adapters intentionally parse the shared AgentOps export schema so
public fixtures can remain synthetic and privacy-safe. `codex-exec-jsonl` and
`claude-code-stream-json` are native stream adapters for explicit CLI JSONL
captures, not private state or transcript-file parsers.

`forensic-text` is deliberately best-effort. It detects shell-prompt commands,
narrative command mentions, file mentions, and final responses from plain text,
then labels command status and report language so inferred evidence is not
merged with observed JSONL/tool evidence.

## What Not To Do

- Do not parse private PAI memory stores.
- Do not make PAI required.
- Do not encode Claude/Codex-specific fields directly into core analyzer logic.
- Do not persist unredacted raw payloads by default.
- Do not publish real transcripts as fixtures.

## Open Research Before Native Direct Adapters

Native adapter research is documented in [Native adapter research](archive/NATIVE_ADAPTER_RESEARCH.md).

Before implementing direct Claude/Codex adapters, collect sanitized examples of each artifact shape:

- completed simple edit
- command failure
- retry loop
- test pass
- test missing
- risky file edit

Each fixture must pass the publication checklist before being committed.

Research recommendation: prefer explicit machine-readable streams first
(`codex exec --json` and `claude -p --output-format stream-json`) and keep raw
transcript-file parsing experimental until sanitized fixture reviews prove it is
safe.

## Hook Envelope JSONL (deferred input shape)

The sanitized hook-envelope format is a documented compatibility target for
bounded local hook capture. AgentOps ships opt-in hook templates under
`templates/hooks/` that can write hook envelopes to ignored local paths, but it
does not yet tail hook files or ingest hook-envelope JSONL as a first-class
adapter (live tailing remains deferred).

Each line is one JSON object wrapping a valid `agentops.event.v1` event:

```json
{"schemaVersion":"agentops.hook-envelope.v1","sessionId":"synthetic-session","sequence":1,"source":"local-agent","capturedAt":"2026-06-28T00:00:00Z","event":{"schemaVersion":"agentops.event.v1","type":"tool_call","toolName":"shell","input":{"cmd":"bun test"},"status":"completed","exitCode":0}}
```

Rules: `event` must be valid `agentops.event.v1`; redact before writing; write to
ignored local paths such as `.agentops/captures/`; never include private memory,
credentials, account data, or unreviewed transcript content; and capture
failures must not block the agent run unless the user configures it.
