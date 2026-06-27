# AgentOps Workbench Agent Instructions

This repository is intended to become public. Treat all source, docs, fixtures, plans, specs, screenshots, and generated reports as publishable artifacts unless they are explicitly ignored.

## Public-Repo Rules

- Do not commit personal names, local filesystem paths, account identifiers, private project names, secrets, tokens, raw transcripts, or unsanitized agent logs.
- Keep PAI-specific content generic. Public docs may describe an optional PAI integration pattern, but must not expose private memory contents, private deployment paths, credential locations, or non-public operational details.
- Use sanitized fixtures only. Synthetic fixtures are preferred until redaction is automated and tested.
- Keep local stores such as `.agentops/`, `.agents/`, SQLite databases, and `.env*` files out of version control.

## Product Direction

AgentOps Workbench is a local-first observability and audit tool for coding-agent sessions. Its public wedge is not general LLM tracing. Its wedge is repo-aware reviewability: tool calls, files changed, shell commands, verification evidence, risk flags, and PR-ready reports.

## Engineering Direction

- TypeScript and Bun remain the default runtime.
- SQLite remains the local persistence layer.
- Markdown reports remain the first-class public output before dashboard work.
- Adapters must normalize into a stable event schema before analyzer/report logic runs.
- Prefer deterministic rule-based checks for the MVP. Add LLM-based scoring only after baseline data capture, redaction, and fixtures are reliable.
