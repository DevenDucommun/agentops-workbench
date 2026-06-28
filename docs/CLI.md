# CLI Reference

AgentOps Workbench is local-first. Commands read session artifacts from disk, store normalized data in SQLite, and write reports to stdout.

## Commands

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
agentops ingest ./fixtures/codex-exec-session.jsonl
```

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
