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
agentops ingest ./fixtures/pai-export-session.jsonl --adapter pai-export-jsonl
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
agentops ingest ./session.jsonl
agentops report --session latest > report.md
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

1. `agentops-jsonl` canonical fixture adapter.
2. `pai-export-jsonl` post-hoc adapter, likely identical to canonical JSONL with PAI-specific source metadata.
3. `codex-jsonl` sanitized AgentOps JSONL export adapter.
4. `claude-code-jsonl` sanitized AgentOps JSONL export adapter.
5. `codex-exec-jsonl` native adapter for `codex exec --json` captures.
6. `claude-code-stream-json` native adapter for `claude -p --output-format stream-json` captures.
7. hook-stream adapter for future live capture.

## Implemented Adapters

These adapter identifiers are stable in `v1.0.0`; see
[Compatibility policy](COMPATIBILITY.md) for the support matrix and boundaries.

The current implementation supports normalized JSONL export artifacts:

- `agentops-jsonl`: canonical `agentops.event.v1` JSONL.
- `pai-export-jsonl`: sanitized `agentops.event.v1` JSONL with `source: "pai"`.
- `claude-code-jsonl`: sanitized `agentops.event.v1` JSONL with `source: "claude-code"`.
- `claude-code-stream-json`: native `claude -p --output-format stream-json` JSONL stream.
- `codex-jsonl`: sanitized `agentops.event.v1` JSONL with `source: "codex"`.
- `codex-exec-jsonl`: native `codex exec --json` JSONL stream.

Use `agentops adapters` to list supported adapters and `agentops adapters --input <file>` to see detection diagnostics for a specific artifact.

The export adapters intentionally parse the shared AgentOps export schema so
public fixtures can remain synthetic and privacy-safe. `codex-exec-jsonl` and
`claude-code-stream-json` are native stream adapters for explicit CLI JSONL
captures, not private state or transcript-file parsers.

## What Not To Do

- Do not parse private PAI memory stores.
- Do not make PAI required.
- Do not encode Claude/Codex-specific fields directly into core analyzer logic.
- Do not persist unredacted raw payloads by default.
- Do not publish real transcripts as fixtures.

## Open Research Before Native Direct Adapters

Native adapter research is documented in [Native adapter research](NATIVE_ADAPTER_RESEARCH.md).

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
