# CLI Reference

AgentOps Workbench is local-first. Commands read session artifacts from disk, store normalized data in SQLite, and write reports to stdout.

For native Claude Code, Codex, and PAI/KAI-style artifact capture patterns, see
[Capture guide](CAPTURE_GUIDE.md).

The documented command surface is stable in `v2.0.0`. See
[Compatibility policy](COMPATIBILITY.md) for compatibility guarantees and
experimental boundaries.

## Commands

## Simple Workflow

Use AgentOps in one of two modes, then inspect, check, save, or open the
results.

For a new audited run, start the agent through AgentOps:

```bash
agentops run codex "review the current diff"
agentops look
agentops check
agentops save
```

or:

```bash
agentops run claude "review the current diff"
agentops look
agentops check
agentops save
```

For after-the-fact audit, import an existing session artifact:

```bash
agentops audit path/to/session.jsonl
agentops look
agentops check
agentops save
```

AgentOps does not need a background service. For live capture, it must launch
the agent command so it can save the JSONL stream. For retrospective audit, it
only needs the saved artifact. Native JSONL remains the recommended source for
full-fidelity review. Plain text transcripts are accepted as lower-confidence
forensic imports when JSONL is unavailable:

```bash
agentops audit path/to/transcript.txt
```

For a local synthetic demo:

```bash
agentops init
agentops demo
agentops look
agentops check
agentops open
```

Running `agentops` with no arguments prints `agentops status`.

### `agentops init`

Applies safe local setup, runs readiness checks, and prints one recommended
next command.

```bash
agentops init
```

The setup creates `.agentops/`, ensures `.agentops/` is ignored by git, and
writes `agentops.config.json` only when it is missing. Existing config files are
not overwritten.

### `agentops doctor`

Checks local readiness and prints the next recommended command.

```bash
agentops doctor
agentops doctor --fix
```

The check covers the Bun runtime, git checkout state, `.agentops/` ignore
status, config validity, SQLite store path, stored sessions, and whether Codex
and Claude CLIs are available on `PATH`.

With `--fix`, doctor applies the same safe local setup fixes as `agentops init`
before running checks.

### `agentops demo`

Imports synthetic demo sessions and prints the fastest inspection, quality
check, and dashboard next steps.

```bash
agentops demo
agentops demo --serve
agentops look sample-session
agentops check sample-session
agentops open --host 127.0.0.1 --port 4927
```

The demo uses only public synthetic fixtures and prints the dashboard URL. With
`--serve`, it starts the local dashboard after importing fixtures.

### `agentops status`

Prints the latest session, quality gate summary, recent sessions, and next
recommended commands.

```bash
agentops
agentops status
```

### `agentops look`

Shows what happened in the latest session or a named session.

```bash
agentops look
agentops look sample-session
```

Use `agentops look` (the `show` alias was removed in v2.0.0).

### `agentops check`

Runs deterministic quality gates for the latest session or a named session.

```bash
agentops check
agentops check sample-session
agentops check --json
agentops check --save
agentops check --format github --save
```

Formats are `text`, `json` (default for `--save`/`--json`), and `github`. The
GitHub format is a PR-comment Markdown body; it is written to a file or stdout
and never posted to GitHub.

`--save` writes a default file whose name matches the format:
`agentops-gate.json` (json), `agentops-gate-comment.md` (github), or
`agentops-gate.txt` (text). Use `--out <file>` to override.

### `agentops save`

Writes review artifacts with default filenames so users do not need to remember
format and output flags.

```bash
agentops save
```

Default bundle:

- `agentops-report.md`
- `agentops-pr-comment.md`
- `agentops-gate.json`
- `agentops-session.json`

Specific saves:

```bash
agentops save report
agentops save pr
agentops save json
agentops save repo-json
agentops save trace
agentops save gate
agentops save pr custom-pr-comment.md
```

### `agentops open`

Starts the local dashboard.

```bash
agentops open
agentops open --port 4930
agentops open --check
```

Use `agentops open` (the `dashboard` command was removed in v2.0.0).

### `agentops mcp`

Starts the local read-only MCP server over stdio.

```bash
agentops mcp
```

The MCP server exposes stored AgentOps evidence to compatible local clients. It
supports session listing, session inspection, session reports, quality gates,
and repo reports. It does not ingest artifacts, capture provider output, post to
GitHub, or read private transcript stores. See [MCP server](MCP.md).

### `agentops audit`

Imports an artifact, prints the session inspection, evaluates quality gates, and
exits non-zero when the gate fails.

```bash
agentops audit path/to/session.jsonl
agentops audit path/to/transcript.txt --out audit.md
```

### `agentops run`

Runs Codex or Claude Code, captures the machine-readable session stream,
ingests it into the local SQLite store, and prints the next review commands.

```bash
agentops run codex "review the current change"
agentops run claude "review the current change"
```

This is the recommended entrypoint for normal use. It is equivalent to
`agentops capture ... --ingest`.

### `agentops capture`

Runs a supported agent CLI in machine-readable mode and writes the JSONL stream
to an ignored local capture file.

This is an advanced compatibility command. Most users should use
`agentops run codex|claude <prompt>`.

Codex capture:

```bash
agentops capture codex "review the current change" \
  --output .agentops/captures/codex-session.jsonl
```

Claude Code capture:

```bash
agentops capture claude "review the current change" \
  --output .agentops/captures/claude-session.jsonl
```

Use `--ingest` to ingest the artifact immediately after a successful capture:

```bash
agentops capture codex "summarize the repo risk areas" --ingest
agentops capture claude "review the current change" --ingest
```

Use `--dry-run` to inspect the provider command without invoking it:

```bash
agentops capture codex "review the current change" --ephemeral --dry-run
agentops capture claude "review the current change" --include-hook-events --dry-run
```

Codex capture invokes `codex exec --json`. Supported Codex options are
`--ephemeral`, `--sandbox`, `--model`, and `--profile`.

Claude capture invokes `claude -p --output-format stream-json --verbose`.
Supported Claude options are `--include-hook-events`, `--no-session-persistence`,
`--model`, and `--permission-mode`.

The captured JSONL artifact is written from provider stdout only. Provider
stderr remains separate so progress output does not contaminate the artifact.

### `agentops adapters`

Lists supported adapters.

```bash
agentops adapters
```

Use `--input` to inspect detection diagnostics for a source artifact:

```bash
agentops adapters --input ./fixtures/codex-session.jsonl
agentops adapters --input ./fixtures/forensic-terminal-transcript.txt
```

For forensic text, diagnostics include observed command, inferred command, file
mention, and provider-marker signals so users can judge transcript strength
before import.

### `agentops import <session.jsonl|transcript.txt>`

Imports a post-hoc session artifact into the local SQLite store.

This is an advanced compatibility command. Most users should use
`agentops audit <artifact>`.

```bash
agentops import ./fixtures/sample-session.jsonl
agentops import ./fixtures/pai-export-session.jsonl
agentops import ./fixtures/claude-code-stream-session.jsonl
agentops import ./fixtures/codex-exec-session.jsonl
agentops import ./fixtures/forensic-terminal-transcript.txt
agentops import ./fixtures/forensic-codex-final-output.txt
agentops import ./fixtures/forensic-claude-text-output.txt
```

Forensic plain-text import uses the `forensic-text` adapter. It labels
shell-prompt commands as `observed`, labels narrative command and file mentions
as `inferred`, and flags final-answer-only transcripts as weak evidence.
The import result prints a compact evidence-quality summary for forensic
transcripts, including observed command count, inferred command count, inferred
file count, and a warning when the transcript is too weak for meaningful
verification.

Real terminal logs can include shell prompts, local paths, environment output,
copied secrets, account names, and private project names. Keep raw transcripts
in ignored local paths until redaction has been reviewed.

The `ingest` alias was removed in v2.0.0; use `agentops import`.

### `agentops config --check`

Validates the local config file without ingesting a session.

```bash
agentops config --check
agentops config --check --config ./agentops.config.json
```

The command catches malformed suppressions and risky raw-payload settings such
as storing raw payloads without redaction and payload hashes.

### `agentops sessions`

Lists recently ingested sessions.

```bash
agentops sessions
agentops sessions --limit 5
```

### Inspecting and saving (use the simple verbs)

`v2.0.0` removed the standalone `inspect`, `review`, `report`, `export`, `gate`,
`repo-report`, `pr`, and `dashboard` commands. Each is now reached through a
simple verb:

| Old command | Use instead |
| --- | --- |
| `agentops inspect <id>` / `agentops review <id>` | `agentops look <id>` |
| `agentops report <id> --out f.md` | `agentops save report <id> --out f.md` |
| `agentops export <id> --format json` | `agentops save json <id> --out f.json` |
| `agentops export <id> --format json --scope repo` | `agentops save repo-json <id> --out f.json` |
| `agentops export <id> --format openinference-json` | `agentops save trace <id> --out f.json` |
| `agentops gate <id>` | `agentops check <id>` |
| `agentops gate <id> --format json\|github` | `agentops check <id> --format json\|github` |
| `agentops repo-report <id> --format github` / `agentops pr <id>` | `agentops save pr <id> --out f.md` |
| `agentops dashboard` | `agentops open` |

`agentops save` writes to a file (default name per kind, or `--out`). For a
combined audit (inspect + gate) of a fresh artifact, use `agentops audit`.

Notes on dropped sub-options: the Markdown-only repo report
(`repo-report --format markdown`) and `export --include-raw-payloads` are not
re-exposed on the simple verbs in `v2.0.0`; the underlying functions remain in
the library. `agentops check --format github` covers the CI gate-comment case.

### `agentops scan-publication`

Runs the baseline public-readiness scan.

```bash
agentops scan-publication
```
