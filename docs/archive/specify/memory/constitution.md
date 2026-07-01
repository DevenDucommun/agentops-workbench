# AgentOps Workbench Constitution

## Core Principles

### I. Public By Default

All committed artifacts must be safe for a future public repository. Plans, specs, architecture notes, fixtures, screenshots, and reports must avoid personal data, local paths, private deployment details, raw secrets, and unsanitized transcripts.

### II. Local-First Trust

The product must work offline for core ingest, storage, analysis, and report generation. Local session data remains local by default. Any future remote export, hosted sync, or third-party observability integration must be explicit and opt-in.

### III. Evidence Over Claims

AgentOps Workbench must distinguish agent claims from observed evidence. Reports should identify what was actually recorded: commands run, files changed, tests executed, risks detected, and final statements made.

### IV. Adapter Boundaries

Agent-runner-specific parsing belongs in ingestion adapters. The normalized event model, analyzers, storage, and reports must not depend on one runner's transcript format.

### V. Repo-Aware Observability

The product should complement general LLM observability tools by focusing on coding-agent workflows: repositories, file churn, shell commands, risky paths, generated files, verification signals, PR reports, and operational readiness.

## Constraints

- Runtime: TypeScript on Bun.
- Storage: SQLite for the local store.
- Initial interface: CLI plus Markdown reports.
- Dashboard: deferred until event model, fixtures, analyzers, and reports are useful.
- Fixtures: synthetic or redacted only.

## Public Release Gate

Before publishing the repository:

- Run a secret scan and a PII/local-path scan.
- Confirm `.agentops/`, `.agents/`, databases, `.env*`, and raw transcripts are ignored.
- Replace raw real transcripts with synthetic or sanitized fixtures.
- Confirm README, docs, specs, and generated reports do not mention private deployment details.
- Confirm license, contribution policy, security policy, and code of conduct decisions are intentional.
