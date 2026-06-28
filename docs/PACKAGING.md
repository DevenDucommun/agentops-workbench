# Packaging Strategy

Status: initial strategy for `v0.5.0`.

## Decision

Use an npm source package as the next distribution path, but do not publish it
until a release checklist explicitly approves publishing.

The package should expose the existing `agentops` bin entry and continue to run
with Bun:

```bash
agentops --help
```

This is intentionally a source package, not a bundled standalone binary. The
CLI uses Bun-native TypeScript execution and local SQLite, so a source package
keeps the implementation simple while the command surface is still changing.

## Why Npm First

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
essential documentation. It intentionally excludes:

- CI configuration
- Spec Kit planning artifacts
- tests
- generated reports
- screenshot assets

## Verification

Run:

```bash
bun run smoke:package
```

The package smoke uses `npm pack --dry-run --json` with a temporary npm cache
and checks that required runtime files are included while repository-only files
are excluded.

Keep using:

```bash
bun run smoke:install
```

to verify the clone/PATH-based install path.
