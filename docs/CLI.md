# CLI Reference

AgentOps Workbench is local-first. Commands read session artifacts from disk, store normalized data in SQLite, and write reports to stdout.

For native Claude Code, Codex, and PAI/KAI-style artifact capture patterns, see
[Capture guide](CAPTURE_GUIDE.md).

The documented command surface is stable in `v1.1.0`. See
[Compatibility policy](COMPATIBILITY.md) for compatibility guarantees and
experimental boundaries.

## Commands

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

### `agentops ingest <session.jsonl>`

Ingests a post-hoc session artifact into the local SQLite store.

```bash
agentops ingest ./fixtures/sample-session.jsonl
agentops ingest ./fixtures/pai-export-session.jsonl --adapter pai-export-jsonl
agentops ingest ./fixtures/claude-code-stream-session.jsonl
agentops ingest ./fixtures/codex-exec-session.jsonl
```

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
agentops inspect --session sample-session
```

### `agentops report`

Generates a Markdown report for one session.

```bash
agentops report --session latest > report.md
```

### `agentops export`

Exports stored data as deterministic JSON.

```bash
agentops export --session latest --format json > agentops-session.json
agentops export --session latest --format json --scope repo > agentops-repo.json
```

By default, exports omit raw payload JSON and local source artifact paths. See
[JSON export](EXPORT.md).

### `agentops repo-report`

Compares the session against the current local git diff.

```bash
agentops repo-report --session latest > repo-report.md
agentops repo-report --session latest --format github > pr-comment.md
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
