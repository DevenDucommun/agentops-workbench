# CLI Reference

AgentOps Workbench is local-first. Commands read session artifacts from disk, store normalized data in SQLite, and write reports to stdout.

For native Claude Code, Codex, and PAI/KAI-style artifact capture patterns, see
[Capture guide](CAPTURE_GUIDE.md).

The documented command surface is stable in `v1.3.0`. See
[Compatibility policy](COMPATIBILITY.md) for compatibility guarantees and
experimental boundaries.

## Commands

## Simple Workflow

Use AgentOps in one of two modes.

For a new audited run, start the agent through AgentOps:

```bash
agentops run codex "review the current diff"
agentops review
agentops dashboard
```

or:

```bash
agentops run claude "review the current diff"
agentops review
agentops dashboard
```

For after-the-fact audit, import an existing session artifact:

```bash
agentops import path/to/session.jsonl
agentops review
```

AgentOps does not need a background service. For live capture, it must launch
the agent command so it can save the JSONL stream. For retrospective audit, it
only needs the saved artifact. Native JSONL remains the recommended source for
full-fidelity review. Plain text transcripts are accepted as lower-confidence
forensic imports when JSONL is unavailable:

```bash
agentops import path/to/transcript.txt
agentops review
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
```

### `agentops import <session.jsonl|transcript.txt>`

Imports a post-hoc session artifact into the local SQLite store.

```bash
agentops import ./fixtures/sample-session.jsonl
agentops import ./fixtures/pai-export-session.jsonl --adapter pai-export-jsonl
agentops import ./fixtures/claude-code-stream-session.jsonl
agentops import ./fixtures/codex-exec-session.jsonl
agentops import ./fixtures/forensic-terminal-transcript.txt
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

`agentops ingest` is kept as a compatibility alias.

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

### `agentops inspect`

Prints a compact inspection view for one session without generating a full report.

```bash
agentops inspect --session latest
agentops inspect latest
agentops inspect --session sample-session
```

### `agentops review`

Reviews one session. With no options it prints the compact inspection view for
the latest session.

```bash
agentops review
agentops review latest --format markdown --out report.md
agentops review latest --format github --out pr-comment.md
agentops review latest --format json --out agentops-session.json
```

### `agentops report`

Generates a Markdown report for one session.

```bash
agentops report latest --out report.md
```

### `agentops export`

Exports stored data as deterministic JSON.

```bash
agentops export latest --format json --out agentops-session.json
agentops export latest --format json --scope repo --out agentops-repo.json
```

By default, exports omit raw payload JSON and local source artifact paths. See
[JSON export](EXPORT.md).

### `agentops repo-report`

Compares the session against the current local git diff.

```bash
agentops repo-report latest --out repo-report.md
agentops repo-report latest --format github --out pr-comment.md
```

The GitHub format is stdout-only. It does not post comments.

### `agentops dashboard`

Starts the local dashboard server backed by the same SQLite store as the CLI.

```bash
agentops dashboard
agentops dashboard --port 4930
agentops dashboard --check
```

The default bind address is `127.0.0.1` and the default port is `4927`. See
[Dashboard](DASHBOARD.md) for scope and browser verification.

### `agentops scan-publication`

Runs the baseline public-readiness scan.

```bash
agentops scan-publication
```
