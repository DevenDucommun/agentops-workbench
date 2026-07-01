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
bun install
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
bun install
./bin/agentops init
./bin/agentops demo
./bin/agentops look
./bin/agentops check
./bin/agentops save
```

Repo-aware output still runs from a source archive, but without `.git` it
compares against an empty diff, so the result is not meaningful:

```bash
./bin/agentops save pr latest
```

Repo-aware PR comments are only meaningful from a git checkout. Use a fresh git
clone when you need them.

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

The current distribution path is source-first: clone the repository or use the
GitHub release source archive. This keeps installation aligned with the tested
Bun runtime, local SQLite behavior, and repo-aware git features. The package
still requires Bun at runtime because `bin/agentops` uses `#!/usr/bin/env bun`.

Npm publication remains deferred until the simplified command surface has
settled; the repository keeps `"private": true` until a release checklist
explicitly approves publishing. The next candidate is an **npm source package**
(not a bundled binary): it matches the existing `agentops` bin entry, lets users
install a normal CLI later, and supports `pack --dry-run` verification — without
platform-specific binary builds. Bun standalone executables and dedicated
release-asset bundles stay deferred until the CLI surface and SQLite behavior
are stable across platforms.

`package.json#files` limits the (future) npm package to runtime source,
fixtures, and essential docs; it excludes CI config, Spec-Kit planning
artifacts, tests, ad-hoc reports outside `docs/demo/`, and screenshot assets.

Packaging-specific smoke tests (`smoke:install`, `smoke:package`,
`smoke:pack-install`, `smoke:release-archive`) were removed while publication is
deferred — reintroduce them in the release checklist when npm publication is
approved. Validate large synthetic-session behavior with `bun run smoke:large-session`.

## Platform Support

Ubuntu CI and local macOS development are exercised. Windows support is not
claimed for the current release line; add Windows CI before documenting it as a
supported platform.

See [Compatibility policy](COMPATIBILITY.md) for the stable `v3.0.0` command,
adapter, schema, and packaging boundaries.
