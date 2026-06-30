# Release Checklist

This checklist must pass before every public release. See
[Release template](RELEASE_TEMPLATE.md) for the command-oriented release flow.

Status: reusable and exercised through `v1.7.0`; v0.1.0 public readiness
passed on 2026-06-28. See
[v0.1.0 readiness result](releases/v0.1.0-readiness-result.md).

## Repository State

- [x] GitHub repo is private until all checks pass.
- [x] Default branch is `main`.
- [x] CI is passing on `main`.
- [x] Dependabot is configured.
- [x] Branch protection is enabled, or documented as unavailable until public/account-plan change.
- [x] No uncommitted local changes are required for the release.

## Public Safety

- [x] `./bin/agentops scan-publication` passes.
- [x] No local SQLite databases are tracked.
- [x] No `.agentops/` contents are tracked.
- [x] No `.agents/` contents are tracked.
- [x] No `.env*` files are tracked.
- [x] No raw real transcripts are tracked.
- [x] No private PAI memory content is tracked.
- [x] No private deployment paths or account identifiers are in docs.
- [x] Generated reports are from synthetic or approved redacted fixtures.

## Product Readiness

- [x] Fresh clone can run `bun install`.
- [x] Fresh clone can run `bun test`.
- [x] Fresh clone can run `bun run ci`.
- [x] Fresh clone can run `bun run smoke:install`.
- [x] Fresh clone can run `bun run smoke:package`.
- [x] Fresh clone can run `bun run smoke:pack-install`.
- [x] Fresh clone can run `bun run smoke:large-session`.
- [x] Fresh clone can run `bun run smoke:dashboard`.
- [x] Fresh clone can run `bun run smoke:demo-artifacts`.
- [x] Fresh clone can run `./bin/agentops doctor`.
- [x] Fresh clone can run `./bin/agentops demo`.
- [x] Fresh clone can run `./bin/agentops audit ./fixtures/sample-session.jsonl`.
- [x] Fresh clone can run `./bin/agentops pr sample-session`.
- [x] Fresh clone can run `./bin/agentops import ./fixtures/sample-session.jsonl`.
- [x] Fresh clone can run `./bin/agentops review`.
- [x] Fresh clone can run `./bin/agentops review latest --format markdown --out report.md`.
- [x] Fresh clone can run `./bin/agentops repo-report latest --out repo-report.md`.
- [x] Fresh clone can run `./bin/agentops repo-report latest --format github --out pr-comment.md`.
- [x] Fresh clone can run `./bin/agentops scan-publication`.
- [x] README explains the product, current CLI, planning docs, and privacy posture.
- [x] Architecture docs explain adapters, storage, analyzers, reports, and PAI boundaries.
- [x] Roadmap explains what is built and what is next.

## Legal And Community

- [x] License is present.
- [x] Security policy is present.
- [x] Contribution guide is present.
- [x] PR template is present.
- [x] Issue templates are present.

## Adapter Readiness

- [x] Canonical JSONL schema is documented.
- [x] Canonical JSONL fixture is synthetic.
- [x] PAI post-hoc export path is documented.
- [x] PAI post-hoc export path has a synthetic fixture.
- [x] Risk, malformed, and missing-timestamp fixtures are synthetic.
- [x] Direct Claude/Codex adapters are not advertised as implemented until tested.
- [x] Any adapter-specific fixture has been redacted and reviewed.

## Release Archive Smoke

After creating a GitHub release, verify the generated source archive:

```bash
bun ./scripts/smoke-release-archive.ts v1.7.0
```

The archive does not include `.git`, so `repo-report` remains a git-checkout
workflow. The archive smoke covers install, help, ingest, sessions, report,
dashboard configuration, guided first-run commands, demo artifacts, package
contents, and publication scan with synthetic fixtures.

## Recommended Pre-Public Commands

```bash
bun install --frozen-lockfile
bun run ci
bun run smoke:large-session
bun run smoke:dashboard
bun run smoke:demo-artifacts
./bin/agentops doctor
./bin/agentops demo
./bin/agentops audit ./fixtures/sample-session.jsonl --out /tmp/agentops-audit.md
./bin/agentops pr --out /tmp/agentops-pr-comment.md
./bin/agentops scan-publication
test -s /tmp/agentops-audit.md
test -s /tmp/agentops-pr-comment.md
```

```bash
git status --short
find . -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3"
```

The database command may show ignored local files. It must not show tracked files in git status.
