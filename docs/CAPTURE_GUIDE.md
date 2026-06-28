# Capture Guide

AgentOps Workbench is safest when it ingests explicit, local, machine-readable
artifacts. Do not point it at private memory stores or raw transcript folders.

## Local Capture Directory

Use an ignored local directory for captures:

```bash
mkdir -p .agentops/captures
```

`.agentops/` is ignored by git. Keep raw captures there until they have been
reviewed, minimized, and sanitized.

## Codex Native JSONL

Codex non-interactive mode can emit JSON Lines with `codex exec --json`.
Capture stdout to an ignored local file:

```bash
codex exec --json "summarize the repo risk areas" \
  > .agentops/captures/codex-session.jsonl
```

For a run that should not persist Codex session rollout files, use
`--ephemeral`:

```bash
codex exec --ephemeral --json "review the current change" \
  > .agentops/captures/codex-session.jsonl
```

Then ingest the capture:

```bash
./bin/agentops adapters --input .agentops/captures/codex-session.jsonl
./bin/agentops ingest .agentops/captures/codex-session.jsonl
./bin/agentops report --session latest > .agentops/captures/report.md
```

## Claude Code Native Stream JSON

Claude Code print mode can emit stream JSON:

```bash
claude -p --output-format stream-json --verbose "review the current change" \
  > .agentops/captures/claude-session.jsonl
```

Hook lifecycle events can be included, but they increase the sensitivity of the
artifact and should stay local unless explicitly sanitized:

```bash
claude -p --output-format stream-json --verbose --include-hook-events "review the current change" \
  > .agentops/captures/claude-session-hooks.jsonl
```

Partial message events are usually not needed for AgentOps reports and can make
captures larger and more sensitive. Prefer full turn events unless debugging a
streaming problem.

Then ingest the capture:

```bash
./bin/agentops adapters --input .agentops/captures/claude-session.jsonl
./bin/agentops ingest .agentops/captures/claude-session.jsonl
./bin/agentops report --session latest > .agentops/captures/report.md
```

## PAI/KAI Post-Hoc Export

PAI/KAI-style integrations should export sanitized `agentops.event.v1` JSONL
after a run. AgentOps should not read private PAI memory stores.

Expected flow:

```bash
./bin/agentops ingest .agentops/captures/pai-export.jsonl --adapter pai-export-jsonl
./bin/agentops report --session latest > .agentops/captures/report.md
```

The exported artifact should contain bounded action evidence: session summary,
tool calls, shell commands, file edits, verification commands, usage metadata
when available, and the final response summary.

## Review Before Publishing

Before moving any capture, fixture, screenshot, or generated report out of
`.agentops/captures/`, check for:

- credentials, tokens, private keys, cookies, or auth files
- private customer, employer, or project names
- private prompts, raw chat content, or sensitive business context
- local absolute paths, usernames, home directories, or machine names
- private repo names or internal service URLs
- command output that includes environment variables or secrets
- hook events that reveal local automation, policy, or tool configuration

Prefer synthetic fixtures for public examples. If a real artifact must be used,
minimize it first and keep only the fields needed to demonstrate the behavior.

Run the publication scan before committing related docs or fixtures:

```bash
./bin/agentops scan-publication
```

The scan is a baseline guard, not a substitute for manual review.

## Public Fixture Rule

Public fixtures should be synthetic or explicitly redacted. Do not commit raw
Claude, Codex, PAI, or KAI captures from real work.
