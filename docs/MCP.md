# MCP Server

`agentops mcp` starts a local Model Context Protocol server over stdio. It lets
compatible local clients read AgentOps evidence from the local SQLite store.

The server is intentionally read-only. It does not ingest artifacts, capture
provider output, run agents, post to GitHub, upload data, or read private
Claude/Codex/PAI transcript stores.

## Start The Server

From a checkout or package directory:

```bash
agentops mcp
```

With an explicit config file:

```bash
agentops mcp --config agentops.config.json
```

MCP clients usually start this command as a stdio subprocess. A generic client
configuration shape is:

```json
{
  "mcpServers": {
    "agentops": {
      "command": "<checkout>/bin/agentops",
      "args": ["mcp"],
      "cwd": "<repo>"
    }
  }
}
```

Use the repository that owns the `.agentops/agentops.db` store as `cwd`. If you
store the database elsewhere, set `AGENTOPS_DB` in the client environment.

## Tools

### `agentops_list_sessions`

Lists recent sessions from the local store.

Arguments:

- `limit`: optional integer from 1 to 100. Defaults to 20.

### `agentops_inspect_session`

Returns the compact session inspection view.

Arguments:

- `sessionId`: optional session id. Use `latest` or omit it for the newest
  session.

### `agentops_session_report`

Returns the Markdown session report.

Arguments:

- `sessionId`: optional session id. Use `latest` or omit it for the newest
  session.

### `agentops_quality_gate`

Evaluates deterministic quality gates for a session.

Arguments:

- `sessionId`: optional session id. Use `latest` or omit it for the newest
  session.
- `format`: optional `text` or `json`. Defaults to `text`.

Failed quality gates are returned as MCP tool errors so clients can distinguish
blocked sessions from passing sessions.

### `agentops_repo_report`

Returns a repo-aware report using the current git diff.

Arguments:

- `sessionId`: optional session id. Use `latest` or omit it for the newest
  session.
- `format`: optional `markdown` or `github`. Defaults to `markdown`.

The repo report reads git status from the current checkout. Use a git checkout,
not a GitHub source archive, when you need repo-aware output.

## Privacy Boundary

The MCP server exposes the same local reports and gate outputs available from
the CLI. It reads normalized session data from SQLite and current git metadata.
It does not read ignored raw capture artifacts unless those artifacts have
already been imported into the AgentOps store.

Keep `.agentops/`, raw captures, and private transcripts out of version control.
Use `agentops scan-publication` before publishing fixtures or reports.

## Compatibility

The server implements MCP over stdio and advertises protocol version
`2025-06-18`. The stable AgentOps contract is the documented tool names,
read-only behavior, and arguments above. Compatible changes may add optional
arguments, optional structured fields, or new read-only tools.
