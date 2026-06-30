# Installation

AgentOps Workbench is currently distributed as a source-first Bun project.
The supported paths are a fresh git clone or a GitHub source archive. Npm
publication and standalone binaries remain deferred.

## Requirements

- Bun 1.3 or newer
- Git, when using repo-aware reports

## Recommended: Fresh Clone

Use this path for development, repo-aware reports, and the local dashboard.

```bash
git clone https://github.com/DevenDucommun/agentops-workbench.git
cd agentops-workbench
bun install --frozen-lockfile
./bin/agentops --help
./bin/agentops init
./bin/agentops demo
./bin/agentops look
./bin/agentops check
./bin/agentops save
```

Repo-aware advanced reports require a git checkout:

```bash
./bin/agentops save pr latest --out pr-comment.md
```

## PATH-Based Local Command

For local use without typing `./bin/` each time:

```bash
export PATH="$PWD/bin:$PATH"
agentops --help
agentops init
agentops demo
agentops status
agentops look
```

This is the currently recommended way to use the `agentops` command from a clone.

The same PATH setup can be used by MCP clients that launch AgentOps over stdio:

```bash
agentops mcp
```

## Bun Link

`bun link` can expose the package binary from a local checkout, but this project is not yet published as a package and does not treat global linking as the primary install path.

Use it only for local experimentation:

```bash
bun link
agentops --help
```

If global link behavior differs across Bun versions, fall back to the PATH-based command.

## GitHub Source Archive

GitHub release source archives are useful for trying the CLI, but they are not git checkouts.

This works from an extracted source archive:

```bash
bun install --frozen-lockfile
./bin/agentops init
./bin/agentops demo
./bin/agentops look
./bin/agentops check
./bin/agentops save
```

This does not work from a source archive because `.git` is not present:

```bash
./bin/agentops save pr latest
```

Use a fresh git clone when you need `repo-report`.

## Five-Minute Synthetic Demo

The repository includes generated demo artifacts from synthetic fixtures:

```bash
ls docs/demo
```

Regenerate them locally:

```bash
bun run demo:artifacts
bun run smoke:demo-artifacts
```

The demo artifacts include a passing session report, a passing quality gate JSON
file, a failing GitHub-ready gate body, and a forensic transcript report. They
are intended for quick inspection before connecting AgentOps to real agent
runs.

## Packaging Strategy

The current distribution path remains source-first: clone the repository or use
the GitHub release source archive. Npm publication remains deferred until the
simplified command surface has settled; publishing should happen only through a
release checklist decision.

The package still requires Bun at runtime because `bin/agentops` uses:

```bash
#!/usr/bin/env bun
```

Validate large synthetic-session ingest/report behavior with:

```bash
bun run smoke:large-session
```

See [Packaging strategy](PACKAGING.md) for the decision, deferred alternatives,
and package content rules.

Bun standalone executables and dedicated GitHub release assets remain deferred
options. Reintroduce packaging-specific smoke verification as part of the
release checklist when npm publication is approved.

## Platform Support

Ubuntu CI and local macOS development are exercised. Windows support is not
claimed for the current release line; add Windows CI before documenting it as a
supported platform.

See [Compatibility policy](COMPATIBILITY.md) for the stable `v1.11.0` command,
adapter, schema, and packaging boundaries.
