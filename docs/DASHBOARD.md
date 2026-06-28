# Dashboard

AgentOps Workbench includes a local dashboard foundation backed by the same
SQLite store used by the CLI.

## Start

Ingest a synthetic session:

```bash
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops ingest ./fixtures/usage-session.jsonl
```

Start the local server:

```bash
./bin/agentops dashboard
```

Default URL:

```text
http://127.0.0.1:4927
```

Use a different local port when needed:

```bash
./bin/agentops dashboard --port 4930
```

Validate the dashboard configuration without starting a long-running server:

```bash
./bin/agentops dashboard --check
```

## Scope

The dashboard currently provides:

- session list
- session timeline
- risk and verification summary
- command drilldown
- file-change drilldown
- token summary when available

It reads from the local SQLite database only. It does not require hosted
services, does not post to GitHub, and does not upload session data.
Dashboard API payloads omit source artifact paths to reduce local-environment
leakage in demos and screenshots.

## API

The local server exposes JSON endpoints used by the browser UI:

```text
GET /api/health
GET /api/sessions?limit=50
GET /api/sessions/:id
```

These endpoints are intended for local dashboard use. They are not a stable
remote API contract yet.

## Privacy

Dashboard demos and screenshots should use synthetic fixtures only.

Do not use real private transcripts, private PAI memory, local personal paths,
credentials, or sensitive command output in public screenshots.

## Browser Verification

Basic manual verification:

1. Run `./bin/agentops ingest ./fixtures/usage-session.jsonl`.
2. Run `./bin/agentops dashboard`.
3. Open `http://127.0.0.1:4927`.
4. Confirm the session list shows `usage-session`.
5. Confirm the timeline, risks, commands, files, and token metric render.

Automated coverage verifies the dashboard JSON endpoints and HTML shell. Visual
screenshots remain manual for this foundation release.
