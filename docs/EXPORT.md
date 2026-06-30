# JSON Export

AgentOps Workbench can export stored session and repo-review data as
deterministic JSON.

## Commands

Session export:

```bash
./bin/agentops save json latest --out agentops-session.json
```

Repo-aware export:

```bash
./bin/agentops save repo-json latest --out agentops-repo.json
```

OpenInference-style span export:

```bash
./bin/agentops save trace latest --out agentops-openinference.json
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

## OpenInference JSON

OpenInference-style exports use:

```text
agentops.openinference.v1
```

This is a deterministic JSON span bundle for local interchange. It is not OTLP
protobuf and does not send data to a collector.

The export includes:

- one root session span with `openinference.span.kind = AGENT`
- event spans with AgentOps event metadata and raw payload hashes
- command spans with `openinference.span.kind = TOOL`
- risk spans with `openinference.span.kind = EVALUATOR`
- token usage attributes when source data includes usage metadata

The export is session-scoped. Repo-aware OpenInference export remains deferred
until there is demand for a stable mapping of git diffs to trace spans.

## Privacy Defaults

By default, JSON export omits:

- local source artifact paths
- raw event payload JSON

It includes raw payload hashes when stored, which allows integrity comparison
without exposing raw transcript content.

`v2.0.0` removed the standalone `agentops export` command and its
`--include-raw-payloads` flag; `agentops save json` / `save repo-json` always
emit privacy-safe exports without raw payload JSON. The
`generateSessionJsonExport`/`generateRepoJsonExport` library functions still
accept an `includeRawPayloads` option for local debugging with trusted data.

OpenInference JSON export always omits raw payload JSON.

## Compatibility

`agentops.export.v1` is stable in `v1.0.0`. Compatible changes may add optional
fields, but exports should remain deterministic and private-data-safe by
default. See [Compatibility policy](COMPATIBILITY.md).
