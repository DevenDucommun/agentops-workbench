# JSON Export

AgentOps Workbench can export stored session and repo-review data as
deterministic JSON.

## Commands

Session export:

```bash
./bin/agentops export --session latest --format json > agentops-session.json
```

Repo-aware export:

```bash
./bin/agentops export --session latest --format json --scope repo > agentops-repo.json
```

## Schema

Current export schema:

```text
agentops.export.v1
```

Session exports include:

- `session`
- `usage`
- `events`
- `commands`
- `files`
- `tools`
- `risks`
- `verification`

Repo exports include the same session data plus:

- `git.changes`
- `git.observedChanges`
- `git.unobservedChanges`
- `git.agentOnlyFiles`

## Privacy Defaults

By default, JSON export omits:

- local source artifact paths
- raw event payload JSON

It includes raw payload hashes when stored, which allows integrity comparison
without exposing raw transcript content.

Use `--include-raw-payloads` only for local debugging with trusted data:

```bash
./bin/agentops export --session latest --format json --include-raw-payloads
```

Do not publish exports that include raw payloads.

## Compatibility

`agentops.export.v1` is stable in `v1.0.0`. Compatible changes may add optional
fields, but exports should remain deterministic and private-data-safe by
default. See [Compatibility policy](COMPATIBILITY.md).
