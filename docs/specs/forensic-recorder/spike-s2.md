# Spike S2: Codex Capture Surface

Status: **decision note** (task T0.3). Answers open question U3 in
[clarify.md](clarify.md): which surface automatic Codex capture should use.
Does not block M1.

## Question

The Claude Code recorder (M1) captures sessions through plugin hooks. Can
Codex sessions be recorded the same way, and if not, through what?

## Candidate surfaces

| Surface | What it is | Verdict |
| --- | --- | --- |
| `codex exec --json` | The JSONL event stream AgentOps already ingests (`agentops run codex`, adapter `codex-exec-jsonl`) | Works today, but only for runs started through AgentOps or by hand in exec mode. Not automatic for interactive sessions |
| Project hooks (`.codex/hooks.json`) | Command hooks configured per repository, the shape of the existing `templates/hooks/codex/hooks.json` | **Recommended.** Automatic once installed, but each repository's hooks must be reviewed and trusted in Codex first |
| Plugin hooks | Hooks shipped inside a Codex plugin, like the Claude Code `agentops-recorder` plugin | Unclear in 0.170 (see evidence). Not relied on |
| Session rollout files | Codex's own saved session history on disk | Rejected. It is a private transcript store, which AgentOps does not read by policy (see [COMPATIBILITY](../../COMPATIBILITY.md#unsupported-or-experimental)) |

## Evidence (Codex CLI 0.170.0, static)

Collected on 2026-11-20 from `codex features list` and the strings in the
standalone 0.170.0 binary. No authenticated Codex run was made, so none of this
is a payload capture yet.

- **Hooks are on.** `codex features list` reports `hooks` as stable and
  enabled.
- **Event names present in the binary:** `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`,
  `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`. There is
  no `PostToolUseFailure`, so a failed tool call probably arrives as
  `PostToolUse` with the failure in `tool_response`.
- **Payload field names present:** `hook_event_name`, `session_id`, `cwd`,
  `transcript_path`, `permission_mode`, `tool_input`, `tool_response`,
  `tool_use_id`, `stop_hook_active`, `last_assistant_message`, plus Codex's
  `turn_id`. These are the Claude Code hook field names that the
  `claude-hooks` adapter and the spool writer already handle.
- **Trust review:** the binary has a startup hook review and "Unable to review
  folder hooks" errors. Project hooks only run after the user trusts them, which
  matches the existing capture guide.
- **Plugin hooks are ambiguous:** `codex features list` shows `plugin_hooks` as
  `removed`, yet the binary still contains plugin hook trust code
  ("failed to trust materialized plugin hooks"). It may mean the flag was
  retired, or that plugin hooks went away. A capture has to settle it.

## Decision

1. **Codex automatic capture uses project hooks.** `agentops recorder enable`
   gains a `--codex` option that writes `.codex/hooks.json` pointing at the same
   `agentops hook <event>` entry, and tells the user to trust the hooks in Codex.
   It never edits Codex's trust state itself.
2. **Same spool, same adapter where the payloads match.** Codex hook records go
   through the existing spool writer, with the recorded source set to `codex`.
   The `claude-hooks` adapter is renamed to a provider-neutral adapter only if a
   capture shows the shapes really match. Otherwise a `codex-hooks` adapter
   reuses its normalizer.
3. **`codex exec --json` stays the supported path until then.** Nothing changes
   for v3.3.0.
4. **No reading of Codex's saved sessions.**

## Before building it (gate)

Run the S1 procedure for Codex, in a scratch repository with authenticated
Codex:

1. Install a dump-everything hook for every event above in `.codex/hooks.json`,
   then trust it.
2. Run one interactive session and one `codex exec` session that each read a
   file, edit a file, run a passing and a failing command, and use a subagent if
   available.
3. Record per event: the field names, the tool names (shell, patch, MCP), how a
   failure is reported, `turn_id` versus `tool_use_id`, how session end is
   signaled, and whether plugin hooks load.
4. Commit only synthetic fixtures built from the field shapes
   (`fixtures/codex-hooks/`), as T0.2 did for Claude Code.

## Follow-up tasks (proposed, after v3.3.0)

- **S2b (S):** the capture above. Output: field table appended here, synthetic
  fixtures.
- **C1 (M):** `agentops recorder enable --codex`, the `.codex/hooks.json`
  writer, and `status` reporting for Codex.
- **C2 (M):** Codex hook normalization (shared or separate adapter), with
  fixtures for each event and the failure shape.
- **C3 (S):** docs (RECORDER, CAPTURE_GUIDE, COMPATIBILITY with the tested Codex
  version) and a fresh-install check like AC1.
