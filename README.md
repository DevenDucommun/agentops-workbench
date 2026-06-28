# AgentOps Workbench

[![CI](https://github.com/DevenDucommun/agentops-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/DevenDucommun/agentops-workbench/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/DevenDucommun/agentops-workbench)](https://github.com/DevenDucommun/agentops-workbench/releases)
[![License](https://img.shields.io/github/license/DevenDucommun/agentops-workbench)](LICENSE)

AgentOps Workbench is a local observability and audit tool for AI coding-agent runs. It helps teams understand what an agent did, what it changed, what evidence supports its final answer, and where the run created risk.

It is built for post-hoc review of Claude Code, Codex, PAI/KAI-style, and other coding-agent workflows through a shared JSONL event schema.

## Status

- Public release: [`v0.3.0`](https://github.com/DevenDucommun/agentops-workbench/releases/tag/v0.3.0)
- Current `main`: includes CLI inspection, sanitized Claude/Codex export adapter work, usage metadata, native adapter research, and dashboard foundation
- Runtime model: local CLI, local SQLite, stdout reports
- Native Claude/Codex transcript parsing: researched, not implemented

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

## Quickstart

Requirements:

- [Bun](https://bun.sh/)
- Git

Run locally:

```bash
git clone https://github.com/DevenDucommun/agentops-workbench.git
cd agentops-workbench
bun install --frozen-lockfile
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops sessions
./bin/agentops inspect --session latest
./bin/agentops report --session latest > report.md
./bin/agentops dashboard
```

Generate a repo-aware PR report:

```bash
./bin/agentops repo-report --session latest > repo-report.md
./bin/agentops repo-report --session latest --format github > pr-comment.md
```

Check public-readiness hygiene:

```bash
./bin/agentops scan-publication
```

## Installation

The recommended install path today is a fresh git clone with Bun:

```bash
git clone https://github.com/DevenDucommun/agentops-workbench.git
cd agentops-workbench
bun install --frozen-lockfile
./bin/agentops --help
```

See [Installation](docs/INSTALLATION.md) for PATH usage, `bun link`, release archive caveats, and future packaging notes.

## Current CLI

Common commands:

```bash
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops adapters
./bin/agentops sessions
./bin/agentops inspect --session latest
./bin/agentops report --session latest > report.md
./bin/agentops repo-report --session latest > repo-report.md
./bin/agentops repo-report --session latest --format github > pr-comment.md
./bin/agentops dashboard --check
./bin/agentops scan-publication
```

See [CLI reference](docs/CLI.md) for command details.

## Supported Artifacts

AgentOps currently ingests normalized post-hoc JSONL exports:

- `agentops-jsonl`: canonical `agentops.event.v1` JSONL
- `pai-export-jsonl`: sanitized PAI/KAI-style AgentOps JSONL export
- `claude-code-jsonl`: sanitized Claude Code AgentOps JSONL export
- `codex-jsonl`: sanitized Codex AgentOps JSONL export

PAI-compatible post-hoc exports use the same canonical JSONL schema:

```bash
./bin/agentops ingest ./fixtures/pai-export-session.jsonl --adapter pai-export-jsonl
./bin/agentops report --session latest > report.md
```

Synthetic Claude Code and Codex exports are also represented as sanitized AgentOps JSONL:

```bash
./bin/agentops ingest ./fixtures/claude-code-session.jsonl
./bin/agentops ingest ./fixtures/codex-session.jsonl
./bin/agentops adapters --input ./fixtures/codex-session.jsonl
```

These fixtures are normalized export examples, not native runtime transcript parsers.

To inspect adapter detection:

```bash
./bin/agentops adapters --input ./fixtures/codex-session.jsonl
```

## Privacy And Safety

AgentOps is local-first by design:

- The default SQLite database lives at `.agentops/agentops.db`.
- `.agentops/`, `.agents/`, local databases, and env files are ignored by git.
- Raw payload storage is disabled by default.
- Raw payload hashes are stored by default.
- Redaction runs before storage by default.
- Public fixtures are synthetic.
- `agentops scan-publication` provides a baseline public-readiness check.

Override the database path when needed:

```bash
AGENTOPS_DB=/path/to/agentops.db ./bin/agentops sessions
```

## Planning And Architecture

Core docs:

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Research and landscape](docs/RESEARCH_LANDSCAPE.md)
- [PAI integration plan](docs/PAI_INTEGRATION.md)
- [Adapter strategy](docs/ADAPTER_STRATEGY.md)
- [Native adapter research](docs/NATIVE_ADAPTER_RESEARCH.md)
- [Event schema](docs/EVENT_SCHEMA.md)
- [Configuration strategy](docs/CONFIGURATION.md)
- [CLI reference](docs/CLI.md)
- [Installation](docs/INSTALLATION.md)
- [Dashboard](docs/DASHBOARD.md)
- [Repo report](docs/REPO_REPORT.md)
- [Publication and privacy plan](docs/PUBLICATION_AND_PRIVACY.md)
- [Changelog](CHANGELOG.md)

Project planning artifacts:

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

## Non-Goals For Current Releases

- Hosted SaaS
- Multi-user auth
- Full trace visualization
- Model benchmarking
- Deep semantic evals
- Direct modification of agent behavior
- Native Claude/Codex transcript parsing

## Tech Direction

- TypeScript + Bun
- SQLite for local storage
- Markdown report output first
- Optional web dashboard later
- Adapter-based ingestion for Claude Code, KAI, and future runners

## Development

```bash
bun install --frozen-lockfile
bun run ci
```

To use the exact `agentops` command during local development, put the repo's `bin` directory on your path:

```bash
export PATH="$PWD/bin:$PATH"
agentops ingest ./fixtures/sample-session.jsonl
agentops report --session latest > report.md
```

## Resume Story

Built AgentOps Workbench, a local TypeScript/Bun observability tool for AI coding agents that ingests agent sessions, normalizes tool/file/command events, flags risk, checks test evidence, and generates engineering-ready audit reports.
