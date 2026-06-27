# Contributing

AgentOps Workbench is currently developed privately with the intent to become public. Contributions, fixtures, docs, and examples should be written as public artifacts from the start.

## Development

```bash
bun test
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops report --session latest > report.md
```

## Public-Safety Requirements

Do not add:

- raw real agent transcripts
- private PAI memory content
- local absolute paths
- account names or emails
- API keys, tokens, credentials, or private keys
- local SQLite databases
- `.env` files
- screenshots with private terminal context

Use synthetic fixtures unless a redacted fixture has been explicitly reviewed.

## Architecture Direction

Read these before larger changes:

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Publication and privacy plan](docs/PUBLICATION_AND_PRIVACY.md)
- [MVP spec](specs/001-agentops-workbench/spec.md)

## Test Expectations

Parser, analyzer, report, and storage changes should include focused tests. Report output should remain deterministic for the same input fixture.
