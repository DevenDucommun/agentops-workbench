# AgentOps Workbench

AgentOps Workbench is a local observability and audit tool for AI coding-agent runs. It helps teams understand what an agent did, what it changed, what evidence supports its final answer, and where the run created risk.

The first target is Claude Code / KAI-style workflows, but the data model should stay generic enough to support other agent runners later.

## Problem

AI coding agents can execute long, high-impact workflows across files, shell commands, MCP tools, tests, and external systems. The transcript usually contains the truth, but it is hard to inspect after the fact.

Engineering leaders need a compact answer to:

- What did the agent do?
- Which files and commands were involved?
- Did it run tests or only claim success?
- Did it touch risky paths or expose secrets?
- How long did it take and how much did it cost?
- Where did it retry, stall, or change direction?
- Is the output good enough to trust?

## Initial Scope

Build a local-first CLI that ingests agent session artifacts and emits a Markdown report.

Do not start with a web dashboard. Start with a reliable event model and useful reports.

## MVP

1. Ingest one Claude/KAI transcript or session log.
2. Parse tool calls, shell commands, file edits, tests, and final response.
3. Store normalized events in SQLite.
4. Run basic risk and evidence checks.
5. Generate a Markdown report for the session.

## Current CLI

Run the first implementation slice locally:

```bash
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops report --session latest > report.md
./bin/agentops repo-report --session latest > repo-report.md
./bin/agentops repo-report --session latest --format github > pr-comment.md
./bin/agentops scan-publication
```

PAI-compatible post-hoc exports use the same canonical JSONL schema:

```bash
./bin/agentops ingest ./fixtures/pai-export-session.jsonl --adapter pai-export-jsonl
./bin/agentops report --session latest > report.md
```

To use the exact `agentops` command during local development, put the repo's `bin` directory on your path:

```bash
export PATH="$PWD/bin:$PATH"
agentops ingest ./fixtures/sample-session.jsonl
agentops report --session latest > report.md
```

The default SQLite database lives at `.agentops/agentops.db`. Override it with `AGENTOPS_DB=/path/to/agentops.db`.

Before making a branch or release public, run:

```bash
./bin/agentops scan-publication
```

## Planning And Architecture

These planning artifacts are written for the future public repository:

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Research and landscape](docs/RESEARCH_LANDSCAPE.md)
- [PAI integration plan](docs/PAI_INTEGRATION.md)
- [Adapter strategy](docs/ADAPTER_STRATEGY.md)
- [Event schema](docs/EVENT_SCHEMA.md)
- [Configuration strategy](docs/CONFIGURATION.md)
- [Repo report](docs/REPO_REPORT.md)
- [Publication and privacy plan](docs/PUBLICATION_AND_PRIVACY.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Spec Kit constitution](.specify/memory/constitution.md)
- [MVP spec](specs/001-agentops-workbench/spec.md)
- [MVP implementation plan](specs/001-agentops-workbench/plan.md)
- [MVP tasks](specs/001-agentops-workbench/tasks.md)

## Example Report Sections

- Session summary
- Timeline of major actions
- Files touched
- Commands run
- Tests and verification evidence
- Risk flags
- Stalls/retries/loops
- Cost/token summary, when available
- Final outcome assessment

## Non-Goals For MVP

- Hosted SaaS
- Multi-user auth
- Full trace visualization
- Model benchmarking
- Deep semantic evals
- Direct modification of agent behavior

## Tech Direction

- TypeScript + Bun
- SQLite for local storage
- Markdown report output first
- Optional web dashboard later
- Adapter-based ingestion for Claude Code, KAI, and future runners

## Resume Story

Built AgentOps Workbench, a local TypeScript/Bun observability tool for AI coding agents that ingests agent sessions, normalizes tool/file/command events, flags risk, checks test evidence, and generates engineering-ready audit reports.
