# Security Policy

## Supported Versions

AgentOps Workbench is pre-release. Security-sensitive findings should be handled privately until the repository is public and a disclosure channel is finalized.

## Data Handling

AgentOps Workbench processes agent-session artifacts that may contain sensitive prompts, file paths, command output, secrets, or private repository context. The project is local-first by design, and core ingest/report workflows should work offline.

Do not commit private session data, raw transcripts, local SQLite databases, `.env` files, API keys, tokens, credentials, private keys, private PAI memory, or screenshots with private context.

## Reporting Security Issues

Before public launch, report issues directly to the repository maintainer through the private development channel.

After public launch, this file should be updated with the preferred disclosure process.

## Public Release Security Gate

Before making the repository public:

- run a secret scanner
- run the public-readiness grep in [Publication and privacy plan](docs/PUBLICATION_AND_PRIVACY.md)
- confirm `.agentops/`, `.agents/`, databases, `.env*`, and raw transcripts are not tracked
- confirm fixtures are synthetic or approved redacted examples
- confirm PAI integration docs do not expose private deployment details
