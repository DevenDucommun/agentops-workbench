# Packaging Strategy

Status: source-package strategy validated through `v2.0.0`.

## Current Distribution Decision

Use fresh clones and GitHub release source archives as the supported
distribution path for the current release line. This keeps installation aligned
with the tested Bun runtime, local SQLite behavior, and repo-aware git
features.

Npm package publication remains deferred until after the simplified CLI surface
has settled. The next packaging candidate is a source package that keeps the
current Bun runtime requirement.

## Next Candidate

Use an npm source package as the next distribution candidate. Publishing remains
deferred; the repository keeps `"private": true` intentionally until a future
release checklist explicitly approves npm publication.

The package should expose the existing `agentops` bin entry and continue to run
with Bun:

```bash
agentops --help
```

This is intentionally a source package, not a bundled standalone binary. The
CLI uses Bun-native TypeScript execution and local SQLite, so a source package
keeps the implementation simple while the command surface is still changing.

## Why Npm Remains The Next Candidate

- It matches the current `package.json` `bin` entry.
- It lets users install a normal CLI package later without learning a custom
  artifact format.
- It supports package dry-run verification before publishing.
- It avoids platform-specific binary builds until demand is clear.

## Deferred Options

### Bun Standalone Binary

A Bun standalone executable can be useful later for users who do not want a Bun
toolchain installed. Defer it until the CLI surface and SQLite behavior are more
stable across platforms.

### GitHub Release Asset

A release asset bundle is viable later, especially if the project adds a
compiled binary. For now, GitHub source archives remain useful smoke artifacts
but not the primary install path.

## Package Contents

`package.json#files` limits the npm package to runtime source, fixtures, and
essential documentation. Synthetic demo artifacts are included so users can
inspect expected report and gate output without importing private data. The
package intentionally excludes:

- CI configuration
- Spec Kit planning artifacts
- tests
- ad hoc generated reports outside `docs/demo/`
- screenshot assets

## Verification

Packaging-specific smoke tests (`smoke:install`, `smoke:package`,
`smoke:pack-install`, `smoke:release-archive`) were removed while npm
publication is deferred, since they validated a distribution path that is not
shipped. The supported install path is a fresh clone with Bun:

```bash
git clone https://github.com/DevenDucommun/agentops-workbench.git
cd agentops-workbench
bun install --frozen-lockfile
./bin/agentops --help
```

Reintroduce dedicated packaging smokes (npm `pack --dry-run`, packed-install,
release-archive) as part of the release checklist when npm publication is
actually approved.

## Platform Coverage

CI currently runs on Ubuntu with Bun `1.3.14`. macOS is exercised manually in
local development. Windows support is not claimed in `v1.0.0`; it should be
documented or added explicitly before npm publication.
