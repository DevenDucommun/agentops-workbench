# Native Adapter Research

Research date: 2026-06-28

## Summary

Native adapter work should proceed, but not by scraping private agent state stores.

The current `agentops-jsonl`, `pai-export-jsonl`, `claude-code-jsonl`, and
`codex-jsonl` adapters remain the public-safe baseline. They ingest sanitized
AgentOps event exports and avoid committing real transcripts, local paths,
secrets, or private PAI memory.

For native adapters, the best first targets are explicit machine-readable
streams:

1. Codex `codex exec --json`
2. Claude Code `claude -p --output-format stream-json`
3. Claude Code hook envelopes for lifecycle capture
4. SDK integrations after the CLI streams are proven

Direct parsing of local transcript files should stay behind an explicit
experimental boundary until synthetic fixtures, redaction, and schema-drift
checks are in place.

## Source Findings

### Codex

Official OpenAI Codex docs expose a strong CLI-native ingestion surface:

- `codex exec --json` writes JSON Lines to stdout.
- The stream includes events such as `thread.started`, `turn.started`,
  `turn.completed`, `turn.failed`, `item.*`, and `error`.
- Item payloads include agent messages, reasoning, command executions, file
  changes, MCP tool calls, web searches, and plan updates.
- `turn.completed` includes usage fields such as input, cached input, output,
  and reasoning output tokens.
- `--output-schema` can request a structured final response, but it is a final
  answer contract, not a full event log.
- `--ephemeral` can avoid persisting session rollout files, which is useful for
  privacy-focused smoke tests.

The Codex SDK is also viable for future integration. The TypeScript and Python
SDKs can start or resume threads and return structured results, with the Python
SDK controlling the local Codex app-server over JSON-RPC.

Codex hooks are useful for live integration, but the hook docs mark
`transcript_path` as a convenience pointer rather than the durable interface.
Hook envelopes are still valuable because they contain `session_id`, hook event
name, tool inputs, tool responses, and Stop/UserPromptSubmit lifecycle points.

Decision: implement the first native Codex adapter against captured
`codex exec --json` output, not private transcript files.

Sources:

- OpenAI Codex non-interactive mode: https://developers.openai.com/codex/noninteractive.md
- OpenAI Codex hooks: https://developers.openai.com/codex/hooks.md
- OpenAI Codex SDK: https://developers.openai.com/codex/sdk.md

### Claude Code

Official Claude Code docs expose two promising native surfaces:

- Print mode supports `--output-format text`, `json`, and `stream-json`.
- `--include-hook-events` can include hook lifecycle events in the stream when
  using `--output-format stream-json`.
- `--session-id`, `--resume`, and `--continue` provide session continuity.
- Hooks receive JSON context via stdin or HTTP request bodies.
- Common hook fields include `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, model/effort metadata, and `hook_event_name`.
- Tool events include `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PostToolUseFailure`, `PostToolBatch`, and permission-denial events.
- Stop and subagent hooks expose final assistant text and continuation signals.
- MCP tools appear as regular tools in Claude Code hook events.
- The Agent SDK exposes built-in tools for reading files, running commands,
  searching, editing, hooks, subagents, session IDs, and result messages.

Claude Code transcript paths are documented in hook inputs, but raw transcript
files can contain user prompts, assistant messages, tool output, local paths, and
sensitive file content. Public fixture work should use synthetic examples or
redacted exports only.

Decision: implement the first native Claude adapter against captured
`claude -p --output-format stream-json --verbose` output or hook envelopes. Keep
direct transcript-file parsing experimental until a fixture review proves the
format and redaction path are safe.

Sources:

- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference.md
- Claude Code hooks reference: https://docs.anthropic.com/en/docs/claude-code/hooks.md
- Claude Code Agent SDK overview: https://docs.anthropic.com/en/docs/claude-code/agent-sdk/overview.md

## Adapter Targets

### `codex-exec-jsonl`

Input: JSONL captured from:

```bash
codex exec --json "summarize this repository"
```

Initial event mapping:

| Codex event | AgentOps event |
| --- | --- |
| `thread.started` | `session` |
| `turn.started` | `message` or timeline marker |
| `item.started` with command execution | `tool_call` |
| `item.completed` with command execution | `command` or `tool_call` with status |
| `item.completed` with file change | `file_edit` |
| `item.completed` with MCP tool call | `tool_call` |
| `item.completed` with agent message | `message` or `final_response` |
| `turn.completed.usage` | `usage` metadata |
| `turn.failed` or `error` | failed `tool_call`, `message`, or run diagnostic |

Open questions before implementation:

- Confirm exact item payloads for Bash, file edits, MCP calls, and web searches
  from synthetic local runs.
- Decide whether command executions should produce both `tool_call` and
  `command` events or only normalized `command` events.
- Capture version metadata from the Codex CLI when available.

### `claude-code-stream-json`

Input: JSONL captured from:

```bash
claude -p --output-format stream-json --verbose "summarize this repository"
```

Optional lifecycle-rich capture:

```bash
claude -p --output-format stream-json --verbose --include-hook-events "summarize this repository"
```

Initial event mapping:

| Claude stream or hook data | AgentOps event |
| --- | --- |
| session init/system message | `session` |
| user/assistant message | `message` |
| tool use start | `tool_call` |
| Bash tool result | `command` |
| Edit/Write/MultiEdit tool result | `file_edit` |
| MCP tool event | `tool_call` |
| Stop hook final message | `final_response` |
| usage/cost result fields when present | `usage` metadata |
| PermissionDenied or blocked hook | `risk` or run diagnostic |

Open questions before implementation:

- Confirm exact stream message types for current Claude Code versions.
- Determine whether hook lifecycle events should be parsed by the same adapter
  or a separate `claude-code-hook-jsonl` adapter.
- Build fixtures without storing real transcript paths or raw file content.

### `agentops-hook-stream`

Future input: normalized envelopes produced by hooks installed into Claude Code,
Codex, PAI, or another local agent runner.

This should be a later integration path because hooks are active instrumentation.
They can affect user trust, agent behavior, local performance, and security
review burden. Post-hoc ingestion remains the safer default.

## Privacy Boundary

Native adapter fixtures must follow these rules:

- Use synthetic sessions or fully redacted exports only.
- Never commit real user prompts, assistant transcripts, local filesystem paths,
  private repo names, email addresses, credentials, or token-bearing output.
- Store hashes or normalized summaries instead of raw payloads unless a user
  explicitly enables raw payload retention.
- Keep transcript-file parsing disabled or experimental until fixture reviews
  prove the format can be sanitized.
- Run `agentops scan-publication` before every public release.

## Performance And Drawbacks

### Post-hoc JSONL exports

Pros:

- lowest operational risk
- easy to review before ingest
- deterministic fixtures
- no runtime hook overhead
- best default for a public repo

Drawbacks:

- depends on another exporter or manual capture
- can miss events not included in the export
- less source-specific metadata

### Native CLI JSONL streams

Pros:

- more complete event coverage
- token usage can be captured directly when exposed
- no private state scraping
- good fit for CI and repeatable smoke tests

Drawbacks:

- CLI event schemas may drift across versions
- long runs can produce large JSONL files
- streaming parsers need robust partial-line and malformed-line diagnostics

### Hook-based capture

Pros:

- captures live lifecycle points
- can observe tool approvals, denials, Stop events, and MCP tool usage
- can integrate with PAI-style local workflows later

Drawbacks:

- hooks require installation, trust review, and user consent
- hooks can add latency or fail independently of the agent run
- hook outputs can contain sensitive tool inputs and responses
- active instrumentation is more complex to document and support

## Fixture Plan

Each native adapter needs synthetic fixtures for:

- simple repo summary
- successful file edit
- failed command
- test pass
- test missing or not run
- permission denial or blocked risky command
- retry or repeated command
- MCP tool call
- usage metadata

The first fixture set should be checked by:

```bash
bun run ci
./bin/agentops scan-publication
```

## Roadmap Recommendation

1. Add `codex-exec-jsonl` parser and synthetic fixtures.
2. Add `claude-code-stream-json` parser and synthetic fixtures.
3. Add native parser schema-drift diagnostics and adapter detection hints.
4. Add optional capture scripts that write JSONL to a local ignored directory.
5. Revisit hook-stream capture once post-hoc native parsing is stable.

