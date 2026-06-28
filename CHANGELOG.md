# Changelog

## Unreleased

### Added

- `agentops adapters` and `agentops adapters --input <file>` for adapter discovery and detection diagnostics.
- `agentops sessions` for listing ingested sessions.
- `agentops inspect --session <id|latest>` for compact session inspection.
- Sanitized AgentOps JSONL export adapters for Claude Code and Codex.
- Synthetic Claude Code and Codex fixture coverage.
- CLI reference documentation.

### Notes

- Claude Code and Codex support currently means normalized, sanitized AgentOps JSONL exports.
- Native runtime transcript parsing remains planned future work.

## v0.1.0 - 2026-06-28

### Added

- Canonical AgentOps JSONL ingestion.
- PAI export JSONL ingestion.
- Local SQLite session store.
- Markdown session reports.
- Local repo reports.
- GitHub-ready PR comment report output.
- Configurable risk and evidence checks.
- `agentops scan-publication` baseline public-readiness scan.

### Security And Release

- Public-readiness checklist passed.
- Main branch protection enabled.
- Required `Test` and `GitGuardian Security Checks` checks enabled.
- GitHub secret scanning, push protection, and Dependabot security updates enabled.
