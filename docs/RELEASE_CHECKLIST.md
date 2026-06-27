# Release Checklist

This checklist must pass before making the repository public.

## Repository State

- [ ] GitHub repo is private until all checks pass.
- [ ] Default branch is `main`.
- [ ] CI is passing on `main`.
- [ ] Dependabot is configured.
- [ ] Branch protection is enabled, or documented as unavailable until public/account-plan change.
- [ ] No uncommitted local changes are required for the release.

## Public Safety

- [ ] `bun run scan:public` passes.
- [ ] No local SQLite databases are tracked.
- [ ] No `.agentops/` contents are tracked.
- [ ] No `.agents/` contents are tracked.
- [ ] No `.env*` files are tracked.
- [ ] No raw real transcripts are tracked.
- [ ] No private PAI memory content is tracked.
- [ ] No private deployment paths or account identifiers are in docs.
- [ ] Generated reports are from synthetic or approved redacted fixtures.

## Product Readiness

- [ ] Fresh clone can run `bun install`.
- [ ] Fresh clone can run `bun test`.
- [ ] Fresh clone can run `bun run ci`.
- [ ] Fresh clone can run `./bin/agentops ingest ./fixtures/sample-session.jsonl`.
- [ ] Fresh clone can run `./bin/agentops report --session latest > report.md`.
- [ ] README explains the product, current CLI, planning docs, and privacy posture.
- [ ] Architecture docs explain adapters, storage, analyzers, reports, and PAI boundaries.
- [ ] Roadmap explains what is built and what is next.

## Legal And Community

- [x] License is present.
- [x] Security policy is present.
- [x] Contribution guide is present.
- [x] PR template is present.
- [x] Issue templates are present.

## Adapter Readiness

- [ ] Canonical JSONL schema is documented.
- [ ] Canonical JSONL fixture is synthetic.
- [ ] PAI post-hoc export path is documented.
- [ ] Direct Claude/Codex adapters are not advertised as implemented until tested.
- [ ] Any adapter-specific fixture has been redacted and reviewed.

## Recommended Pre-Public Commands

```bash
bun install --frozen-lockfile
bun run ci
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops report --session latest > /tmp/agentops-report.md
test -s /tmp/agentops-report.md
```

```bash
git status --short
find . -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3"
```

The database command may show ignored local files. It must not show tracked files in git status.
