# Installation

The recommended install is a **standalone binary** (no Bun, no clone). A fresh
git clone with Bun remains the path for development and contributions. Npm
publication is still deferred.

## Recommended: Standalone Binary

```bash
curl -fsSL https://raw.githubusercontent.com/DevenDucommun/agentops-workbench/main/install.sh | sh
agentops --help
```

The installer detects your OS/arch (macOS and Linux, arm64/x64), downloads the
matching binary from the latest GitHub release, and installs it to
`/usr/local/bin`. Overrides:

- `AGENTOPS_INSTALL_DIR` — install directory (default `/usr/local/bin`)
- `AGENTOPS_VERSION` — release tag to install (default: latest)

You can also download a binary directly from the
[releases page](https://github.com/DevenDucommun/agentops-workbench/releases) and
put it on your PATH. The binary is self-contained — the Bun runtime and SQLite
are bundled in. Binaries are built with `bun build --compile`
(`bun run build:binaries`) and uploaded by the release workflow.

## Requirements (from source)

- Bun 1.3 or newer
- Git, when using repo-aware reports

## From Source: Fresh Clone

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

As of `v3.1.0` the primary distribution is **standalone binaries** built with
`bun build --compile` (mac/Linux, arm64/x64) and uploaded as GitHub release
assets by the release workflow. They bundle the Bun runtime and SQLite, so the
end user needs nothing installed. A fresh clone with Bun stays the development
path (running from source still requires Bun because `bin/agentops` uses
`#!/usr/bin/env bun`).

Npm publication remains deferred; the repository keeps `"private": true` until a
release checklist explicitly approves publishing. If pursued, the candidate is an
**npm source package** (matches the existing `agentops` bin entry and supports
`pack --dry-run`), complementary to the binaries.

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
