# Spike S1: Claude Code hook capture

Status: **done** (T0.1). Resolves U1 and U2 in [clarify.md](clarify.md).
Feeds T0.2 (synthetic fixtures), T1.3 (spool writer) and T1.4 (hook
entrypoint).

## Summary

- The hook surface covers everything M1 needs. Tool calls pair cleanly by
  `tool_use_id`, subagents are identified by `agent_id`, and a `git commit`
  run through Bash reports its SHA in the tool response.
- A failing command (including a failing test run) arrives as
  `PostToolUseFailure` with an `error` string. It never arrives as
  `PostToolUse` with a non-zero exit code.
- The recommended budget is **p95 ≤ 50 ms per hook** (target p50 ≤ 30 ms),
  measured on the release binary. A lean hook entry meets it with room to
  spare. The full CLI already spends about 44 ms p95 on startup alone, so
  `agentops hook` must not load the full CLI.
- Write-time redaction is blocked by a quadratic-time pattern in
  `src/redaction.ts` (see [Redaction cost](#redaction-cost)). Fix it before
  T1.3.

## Method

- **Environment.** Claude Code **2.1.328**, Bun 1.4.3, macOS 15 on arm64.
- **Capture.** A throwaway git repo held a small module with a deliberate
  bug and a failing test. Its project `.claude/settings.json` registered one
  command hook, with an empty matcher, on 24 events: every documented event
  that a headless session could plausibly fire. The hook appended its stdin
  unchanged to a JSONL file. Sessions ran with `claude -p --setting-sources
  project` so no user or plugin hooks fired.
- **Sessions.** Run 1 was one headless session with ten turns. It ran a
  failing `cat`, a failing `bun test`, an Explore subagent, Read, Edit, Write
  and a passing `bun test`, then made a git commit. Run 2 resumed that
  session with `--resume` for one more prompt. The capture holds 38 events
  and every line parses.
- **Analysis.** The raw captures stayed outside the repo. Only field names,
  JSON types, enum values and cross-event relations (ID equality, ordering)
  were extracted. **No payload value from the captures appears in this
  document or in the repo.**
- **Event set.** It was checked against the current hooks reference
  (code.claude.com/docs/en/hooks), which documents 33 events. Fields marked
  *docs* below come from that reference and were not observed in this run.

## Observed event order (run 1, then run 2)

```text
SessionStart(startup) > UserPromptSubmit
> PreToolUse:Bash > PostToolUseFailure:Bash            (cat, exit 1)
> PreToolUse:Bash > PostToolUseFailure:Bash > PostToolBatch   (bun test, exit 1)
> PreToolUse:Agent
    > SubagentStart > PreToolUse:Grep > PostToolUse:Grep > PostToolBatch > SubagentStop
  > PostToolUse:Agent > PostToolBatch
> PreToolUse:Read > PostToolUse:Read > PostToolBatch
> PreToolUse:Edit > PostToolUse:Edit > PreToolUse:Write > PostToolUse:Write > PostToolBatch
> (Bash Pre/Post/Batch x3: touch, bun test, git add+commit)
> Stop > SessionEnd(other)
SessionStart(resume) > UserPromptSubmit > Stop > SessionEnd(other)
```

- Every `PostToolUse` or `PostToolUseFailure` has a matching `PreToolUse`
  with the same `tool_use_id`, and every `PreToolUse` has one of the two.
  This held for all 10 tool calls.
- `PostToolBatch` fires once per model turn after its tool calls. It holds 1
  or 2 entries here, and every one of them also appeared as a per-tool event.
- A resumed session keeps the same `session_id`. Both runs share one ID, and
  the resume emits a new `SessionStart` and `SessionEnd`.

## Common fields

| Field | Type | Present on | Notes |
|-------|------|------------|-------|
| `session_id` | string (UUID) | all | Same value for subagent events and after `--resume` |
| `transcript_path` | string | all | The private transcript; the recorder must not parse it (spec non-goal) |
| `cwd` | string | all | Absolute path; redact as a local path |
| `hook_event_name` | string | all | |
| `prompt_id` | string | all except `SessionStart` | One value per user prompt; groups a turn's events |
| `permission_mode` | string | all except `SessionStart` and `SessionEnd` | Observed `acceptEdits` and `default` |
| `effort` | **object** `{ level: string }` | tool, batch, subagent and stop events | Observed `low` and `medium`. It is an object, not a string |
| `agent_id` | string (17 hex chars) | events *inside* a subagent only | Absent on the parent's `Agent` Pre/Post |
| `agent_type` | string | same as `agent_id` | Observed `Explore` |

## Per-event fields

| Event | Observed fields (beyond common) | Notes |
|-------|----------------------------------|-------|
| `SessionStart` | `source` | `startup`: only the five base keys, no `model`. `resume`: adds `seconds_since_last_response` (number), `context_tokens` (number), `prompt_cache_likely_expired` (boolean), `estimated_cache_write_usd` (number) |
| `UserPromptSubmit` | `prompt` | Full prompt text, so redact it |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | `tool_use_id` starts with `toolu_` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | `tool_response` shape depends on the tool (table below) |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`, `duration_ms` | **No `tool_response`.** For Bash, `error` starts with `Exit code N` and then holds the output. A failing `bun test` puts its pass/fail summary inside `error` |
| `PostToolBatch` | `tool_calls[]` of `{ tool_name, tool_input, tool_use_id, tool_response }` | Here `tool_response` is the **model-facing text** (string, or an array of `{type,text}` for `Agent`), not the structured object. Use `PostToolUse` for structure |
| `SubagentStart` | `agent_id`, `agent_type` | No `permission_mode` or `effort` |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]` | `agent_transcript_path` is `<transcript without .jsonl>/subagents/agent-<agent_id>.jsonl` |
| `Stop` | `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]` | |
| `SessionEnd` | `reason` | Observed only `other` (headless). *Docs*: `clear`, `resume`, `logout`, `prompt_input_exit`, `other` |

### `tool_input` and `tool_response` by tool (PostToolUse)

| Tool | `tool_input` | `tool_response` |
|------|--------------|-----------------|
| Bash | `command`, `description` | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`; on a commit also `gitOperation.commit.{sha, kind, branch}` |
| Read | `file_path` | `type` (`text`), `file.{filePath, content, numLines, startLine, totalLines}` |
| Edit | `file_path`, `old_string`, `new_string`, `replace_all` | `filePath`, `oldString`, `newString`, **`originalFile`** (whole file before the edit), `structuredPatch[].{oldStart, oldLines, newStart, newLines, lines[]}` (lines prefixed ` `, `-`, `+`), `userModified`, `replaceAll` |
| Write | `file_path`, `content` | `type` (`create`), `filePath`, `content`, `structuredPatch[]`, `originalFile` (null on create), `userModified` |
| Grep | `pattern`, `path`, `output_mode`, `-n` | `mode`, `numFiles`, `filenames[]`, `content`, `numLines`, `totalLines` |
| Agent | `description`, `prompt`, `subagent_type`, `effort`, `run_in_background` | `status` (`completed`), `agentId`, `agentType`, `prompt`, `content[]`, `toolsUsed[]`, `resolvedModel`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage{…}`, `toolStats.{readCount, searchCount, bashCount, editFileCount, linesAdded, linesRemoved, otherToolCount}`, `canContinueAgent`, plus harness counters |

## Subagent identifiers

- `SubagentStart.agent_id`, `SubagentStop.agent_id` and the parent's
  `PostToolUse:Agent` `tool_response.agentId` are the **same value**. That
  value links the subagent's events to the parent tool call.
- The parent's `PreToolUse:Agent` carries `tool_use_id` but no `agent_id`.
  The link from a parent `tool_use_id` to an `agent_id` therefore only
  exists once `PostToolUse:Agent` arrives. Until then, the subagent events
  fall between that Pre and Post in spool order.
- Tool events inside the subagent carry `agent_id` and `agent_type` and
  share the parent's `session_id`. One spool per session therefore holds
  the whole tree.
- No `parent_tool_use_id` field exists. Map R1.5's `parentToolUseId` from the
  enclosing `Agent` call by `agent_id`, at ingest.

## Implications for M1

1. **Spool keying.** Use one spool per `session_id`; it covers subagents and
   resume. Use `prompt_id` to group turns.
2. **Failures.** The adapter must treat `PostToolUseFailure` as the tool
   result. A failing test is a failure event whose output is in `error`.
   Evidence-claim rules that look for test output in `stdout` must also read
   `error`.
3. **Commit linking (R1.8).** `gitOperation.commit.sha` is a **7-character
   short SHA**. Resolve it to the full SHA with `git rev-parse` at ingest
   (or in the hook, if within budget). It is only present when the commit
   ran through the Bash tool.
4. **Content hashing (R1.5).** Compute `contentHash` from the Edit
   `structuredPatch` and Write `content`. Then drop or hash `originalFile`
   and Read's `file.content` at write time. They hold whole files and
   dominate both size and privacy risk.
5. **Ignore `PostToolBatch` for structure.** It duplicates per-tool events
   with model-facing text. Register it only if a turn boundary is needed;
   `prompt_id` already provides one.
6. **Register these events.** `SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`,
   `SubagentStop`, `Stop` and `SessionEnd`. Consider `PermissionDenied` for
   M2's blocked-attempt policy (not observed here; see gaps).
7. **SessionEnd ingest.** The docs give SessionEnd hooks a shared 1.5 s
   budget, extendable through `timeout`. Ingest at session end must either
   fit that or detach. Analysis inside the hook will not fit.

## Latency

Each candidate was spawned through `sh -c`, the way Claude Code runs command
hooks, with a synthetic `PostToolUse` payload of about 20 KB on stdin. Each
run did 300 interleaved rounds after 10 warm-up rounds. The table shows wall
time from spawn to exit in ms. The bench ran inside a macOS Seatbelt
sandbox, which adds a little overhead per spawn, so absolute numbers outside
a sandbox should be slightly lower.

| Candidate | p50 | p95 | p99 |
|-----------|-----|-----|-----|
| `sh -c true` (floor) | 5.5 | 7.5 | 11.9 |
| POSIX `cat >> spool` | 8.4 | 11.7 | 17.5 |
| `bun run writer.ts` (not compiled) | 24.5 | 31.6 | 42.1 |
| Compiled Bun minimal writer (stdin → `O_APPEND`) | 23.8 | 30.1 | 43.3 |
| **Lean compiled hook entry** (parse, `redactValue`, `sha256`, append) | **26.9** | **33.9** | 42.2 |
| agentops v3.2.0 binary, full CLI load, no work (`help` path) | 36.1 | 44.2 | 58.3 |
| v3.2.0 binary followed by the minimal writer (upper bound for "full CLI + work") | 52.7 | 65.1 | 84.1 |

The v3.2.0 binary was built with the release `bun build --compile
--target=bun-darwin-arm64` command, from a tree with no `src/` changes since
the v3.2.0 tag. Two earlier runs with N=200 and N=300 agreed within a few ms
at p50 and p95.

**First exec after install.** The first run of a newly written compiled
binary took **680–790 ms** in three trials, then dropped to normal speed.
This matches macOS first-launch checking. It hits once per install or
upgrade, on whichever hook fires first.

### Recommended budget

- **p95 ≤ 50 ms, p50 ≤ 30 ms per hook**, measured by `smoke:recorder` on the
  release binary with a payload of about 20 KB. This confirms the target in
  spec R1.4.
- **Requirement on T1.4.** `agentops hook` must reach its handler without
  loading the rest of the CLI (SQLite store, analyzer, dashboard, MCP). Use
  a dynamic `import()` from the command dispatch or a separate entry
  module. The lean entry above is the reference shape.
- **Mitigation for the first exec.** Have `agentops recorder enable` run the
  binary once, so the first-launch check does not land on a live tool call.
- **Fallback.** If a future change pushes the lean entry over budget, the
  compiled minimal writer (about 30 ms p95, no parsing) is the fallback.
  Redaction and hashing then move to ingest. That trades R1.3's write-time
  redaction for latency and needs a spec change, so it is not the default.

## Redaction cost

The `email` pattern in `src/redaction.ts`,
`/[A-Za-z0-9._%+-]+@…/g`, takes quadratic time on long runs of matching
characters with no `@`. At every start position the engine scans to the end
of the run.

| Input to `redactString` | Time |
|-------------------------|------|
| 20 KB of prose lines | 0.1 ms |
| 20 KB base64 | 0.7 ms |
| 20 KB single token | 97 ms |
| 100 KB single token | 2,586 ms |

Long tokens are common in tool output: minified bundles, lockfile hashes,
long log lines. With the 20 KB token payload, the lean hook entry rose to
127 ms p50. The same pattern already runs at ingest. T1.3 needs a
linear-time email rule as a prerequisite, for example by bounding the local
part (`{1,64}`) and anchoring on a word boundary, plus a test with a long
single token. That fix is out of scope for this spike.

## Gaps (not observed in this run)

- **`PermissionRequest` and `PermissionDenied`.** The test command meant to
  trigger a denial ran, because `acceptEdits` allows it. Confirm the
  `PermissionDenied` shape (*docs*: `tool_name`, `tool_input`,
  `tool_use_id`, `reason`) before T2.4.
- **Interactive `SessionEnd` reasons.** Headless sessions report only
  `other`. `prompt_input_exit`, `clear` and `logout` are documented but were
  not captured.
- **MCP tools** (`mcp_server` field), **`StopFailure`**, **`PreCompact` and
  `PostCompact`**, and **background subagents** (`run_in_background: true`).
- **`model` on `SessionStart`** is optional in the docs and was absent here.
  Do not depend on it.

## For T0.2 fixtures

Build the five fixture sessions from the shapes above with synthetic values.
Use a UUID `session_id`, `toolu_`-prefixed `tool_use_id`s, a 17-hex-char
`agent_id`, a 7-character commit SHA, an `effort` object and `Exit code N`
error prefixes. Keep the observed event order, including subagent events
between `PreToolUse:Agent` and `PostToolUse:Agent`, and a `PostToolBatch`
after each turn.

The failing-test fixture must use `PostToolUseFailure`. The redaction cost
regression input (a 20 KB single token) belongs in the T1.3 redaction test,
generated in code, rather than in a committed fixture.
