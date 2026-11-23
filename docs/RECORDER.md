# Forensic Recorder (preview)

The recorder captures Claude Code sessions automatically, through Claude Code
hooks, in the repositories you enroll. There is no wrapper command to remember:
start `claude` as usual, and when the session ends it shows up in
`agentops sessions`, `agentops look`, `agentops check` and the dashboard.

Status: preview, targeted at v3.3.0. Design:
[forensic recorder spec](specs/forensic-recorder/spec.md).

## Requirements

- The `agentops` binary from this release or later, on `PATH`
  ([installation](INSTALLATION.md)). If it lives somewhere else, export
  `AGENTOPS_BIN=/path/to/agentops` in the shell you start `claude` from.
- Claude Code with plugin support. macOS or Linux.

## Set Up

1. Install the plugin, once per machine. In a Claude Code session:

   ```text
   /plugin install agentops-recorder --marketplace DevenDucommun/agentops-workbench
   ```

   Or from a shell:

   ```bash
   claude plugin marketplace add DevenDucommun/agentops-workbench
   claude plugin install agentops-recorder@agentops-workbench
   ```

2. Enable recording for a repository, from anywhere inside it:

   ```bash
   agentops recorder enable
   ```

   Recording is opt-in per repository. Linked git worktrees of an enabled
   repository are recorded too. Repositories you have not enabled record
   nothing, even with the plugin installed.

3. Use Claude Code as usual. When a session ends (`/exit`, `/clear`, or the
   end of a `claude -p` run), it is imported into the repository's store:

   ```bash
   agentops sessions
   agentops look
   agentops check
   ```

Check the setup at any time with `agentops recorder status`. Stop recording a
repository with `agentops recorder disable`.

## What Gets Recorded

Each hook call appends one record to a per-session spool file:

| Event | Becomes |
| --- | --- |
| `UserPromptSubmit` | the user's prompt |
| `PostToolUse` / `PostToolUseFailure` | a tool call: Bash commands with exit codes, file edits and writes with line counts, file reads, subagent calls |
| `SubagentStart` / `SubagentStop` | subagent activity, linked to the `Agent` call that ran it |
| `Stop` | the assistant's final message for the turn |
| `SessionStart` / `SessionEnd` | session boundaries; `SessionEnd` also triggers the import |

A `git commit` run through the Bash tool links the session to the commit, so
the session can be found from the commit later.

## Privacy

Recorded data is real session data: keep it private and never commit it.
In short, records pass through best-effort, pattern-based redaction before
they are written, some fields (such as
written file contents and command output) are reduced to a length and sha256,
and most other text, including prompts and Bash commands, is kept after
redaction. Claude Code's transcript files are never read, and nothing is
uploaded.

Exactly which fields are kept, how paths are handled, what happens to records
over 1 MiB, where everything is stored and how to remove it are described in
one place: [forensic recorder data](PUBLICATION_AND_PRIVACY.md#forensic-recorder-data).

## Where Data Lives

The recorder keeps a registry and per-session spools in a state directory,
`<state>` below, and imports sessions into the repository's store.
`agentops recorder status` prints both locations. How `<state>` and the store
are chosen, and how to keep them out of version control, are in
[where it lives](PUBLICATION_AND_PRIVACY.md#where-it-lives). Nothing is
deleted automatically.

### Removing recorded data

`agentops recorder disable` stops new capture only; nothing already recorded is
deleted. The steps to remove spools, imported sessions or all recorder state,
and their caveats, are in
[removal](PUBLICATION_AND_PRIVACY.md#removal).

## Turn-End Verdict (optional)

To see a one-line quality-gate summary after each Claude Code turn, add this to
the repository's `agentops.config.json`:

```json
{ "recorder": { "verdict": true } }
```

Claude Code then shows a notice such as
`agentops: needs review: Verification evidence: No observed verification
command recorded (agentops look <session>)`. It never blocks the session. It
is off by default because a turn without a test run reads as "needs review"
under the default gate. Claude Code discards anything printed at session end,
so the summary appears at turn end instead.

## Behavior Guarantees

- Hooks always exit 0 and print nothing (apart from the optional verdict), so
  the recorder cannot block or interrupt Claude Code.
- The per-tool-call hook is budgeted at p95 ≤ 50 ms; `bun run smoke:recorder`
  checks it against the release binary.
- If the `agentops` binary is missing, the plugin's hooks do nothing and show
  no error.
- Parallel hook calls in one session are serialized with a lock, so the record
  stays in order and its hash chain stays valid.

## Troubleshooting

- **No sessions after `/exit`:** run `agentops recorder status`. It shows
  whether the repository is enabled, whether `agentops` is on `PATH`, and how
  many recorded sessions the store holds. Check that the plugin is installed
  and enabled (`claude plugin list`).
- **Recorder errors:** see `<state>/spool/*.errors.jsonl`. Each line names the
  reason (`lock-timeout`, `write-failed`, `ingest-failed`, `verdict-failed`).
- **Import an old spool by hand:** `agentops audit <state>/spool/<session-id>.jsonl`,
  from the recorded repository. This restores the session's events and its
  commit links, and recomputes risk flags under the current configuration. An
  abbreviated commit SHA resolves to the full SHA when the spool also records
  it in full (a push) or the commit exists in the repository the import runs in.
