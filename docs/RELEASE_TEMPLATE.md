# Release Template

Use this template for every release candidate.

## Pre-Merge

```bash
bun install --frozen-lockfile
bun run ci
bun run smoke:large-session
bun run smoke:dashboard
git status --short
```

## Release PR

- Update `package.json` version.
- Update `CHANGELOG.md`.
- Update README status.
- Update `docs/archive/ROADMAP.md`.
- Link the milestone tracking issue.

## Post-Release

```bash
gh release create <tag> --target main --title <tag> --notes-file <notes.md>
```

- Close the GitHub milestone.
- Confirm local `main` is clean and tagged.
