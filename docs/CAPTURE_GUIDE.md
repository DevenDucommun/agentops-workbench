# Capture Guide

AgentOps Workbench is safest when it ingests explicit, local, machine-readable
artifacts. Do not point it at private memory stores or raw transcript folders.

## Two Modes

AgentOps can be used in two ways:

- Live capture: start the agent through AgentOps with `agentops run`.
- Retrospective audit: import an existing JSONL artifact or lower-fidelity
  plain-text transcript with `agentops import`.

AgentOps does not run as a daemon. It either launches the provider command and
saves its JSONL stream, or it analyzes an artifact that already exists.

Recommended live capture:

```bash
./bin/agentops run codex "review the current diff"
./bin/agentops review
```

```bash
./bin/agentops run claude "review the current diff"
./bin/agentops review
```

For after-the-fact audit, the source run must have produced a supported
machine-readable artifact:

```bash
codex exec --json "review the current diff" > codex-session.jsonl
./bin/agentops import codex-session.jsonl
./bin/agentops review
```

```bash
claude -p --output-format stream-json --verbose "review the current diff" > claude-session.jsonl
./bin/agentops import claude-session.jsonl
./bin/agentops review
```

Plain terminal output or a copied chat transcript can be imported for
lower-confidence forensic analysis:

```bash
./bin/agentops import transcript.txt
./bin/agentops review
```

Use provider JSONL/stream JSON output when you want a session to be auditable
later with full-fidelity tool and command evidence.

## Forensic Plain Text

The `forensic-text` adapter is a fallback for saved terminal logs and copied
coding-agent text. It detects shell-prompt commands, narrative command
mentions, file mentions, final claims, and obvious verification commands.

Reports label this evidence quality:

- Shell-prompt commands are `observed`.
- Commands and file changes mentioned in prose are `inferred`.
- Inferred verification commands are review evidence, not full observed
  verification.
- Final-answer-only transcripts are accepted as weak audits and flagged for
  missing command evidence.

Real terminal logs can include shell prompts, local paths, environment output,
tokens, account identifiers, private project names, and copied secrets. Keep
raw text transcripts under ignored paths such as `.agentops/captures/` until
redaction has been reviewed.

## Local Capture Directory

Use an ignored local directory for captures:

```bash
mkdir -p .agentops/captures
```

`.agentops/` is ignored by git. Keep raw captures there until they have been
reviewed, minimized, and sanitized.

## Codex Native JSONL

AgentOps can run Codex non-interactive mode and capture `codex exec --json`
stdout to an ignored local JSONL file:

```bash
./bin/agentops capture codex "summarize the repo risk areas" \
  --output .agentops/captures/codex-session.jsonl
```

Use `--ingest` to capture and ingest in one step:

```bash
./bin/agentops capture codex "review the current change" \
  --output .agentops/captures/codex-session.jsonl \
  --ingest
```

For a run that should not persist Codex session rollout files, pass
`--ephemeral` through the capture command:

```bash
./bin/agentops capture codex "review the current change" \
  --ephemeral \
  --output .agentops/captures/codex-session.jsonl
```

Codex progress and diagnostics are kept separate from the JSONL artifact.
AgentOps writes only provider stdout to the capture file.

You can still run the provider command manually when you need complete shell
control:

```bash
codex exec --json "summarize the repo risk areas" \
  > .agentops/captures/codex-session.jsonl
```

Then import the capture:

```bash
./bin/agentops adapters --input .agentops/captures/codex-session.jsonl
./bin/agentops import .agentops/captures/codex-session.jsonl
./bin/agentops review latest --format markdown --out .agentops/captures/report.md
```

## Claude Code Native Stream JSON

AgentOps can run Claude Code print mode and capture stream JSON to an ignored
local JSONL file:

```bash
./bin/agentops capture claude "review the current change" \
  --output .agentops/captures/claude-session.jsonl
```

Use `--ingest` to capture and ingest in one step:

```bash
./bin/agentops capture claude "review the current change" \
  --output .agentops/captures/claude-session.jsonl \
  --ingest
```

The capture command invokes `claude -p --output-format stream-json --verbose`.
AgentOps writes only provider stdout to the capture file so progress output does
not contaminate JSONL.

You can still run the provider command manually when you need complete shell
control:

```bash
claude -p --output-format stream-json --verbose "review the current change" \
  > .agentops/captures/claude-session.jsonl
```

Hook lifecycle events can be included, but they increase the sensitivity of the
artifact and should stay local unless explicitly sanitized:

```bash
./bin/agentops capture claude "review the current change" \
  --include-hook-events \
  --output .agentops/captures/claude-session-hooks.jsonl
```

Equivalent manual provider command:

```bash
claude -p --output-format stream-json --verbose --include-hook-events "review the current change" \
  > .agentops/captures/claude-session-hooks.jsonl
```

Partial message events are usually not needed for AgentOps reports and can make
captures larger and more sensitive. Prefer full turn events unless debugging a
streaming problem.

Then import the capture:

```bash
./bin/agentops adapters --input .agentops/captures/claude-session.jsonl
./bin/agentops import .agentops/captures/claude-session.jsonl
./bin/agentops review latest --format markdown --out .agentops/captures/report.md
```

## PAI/KAI Post-Hoc Export

PAI/KAI-style integrations should export sanitized `agentops.event.v1` JSONL
after a run. AgentOps should not read private PAI memory stores.

Expected flow:

```bash
./bin/agentops import .agentops/captures/pai-export.jsonl --adapter pai-export-jsonl
./bin/agentops review latest --format markdown --out .agentops/captures/report.md
```

The exported artifact should contain bounded action evidence: session summary,
tool calls, shell commands, file edits, verification commands, usage metadata
when available, and the final response summary.

## Hook Envelope Templates

AgentOps includes opt-in hook templates for users who want bounded local hook
envelopes. They are examples, not automatic installation steps.

The helper script reads hook JSON from stdin and appends
`agentops.hook-envelope.v1` records to `.agentops/captures/hook-events.jsonl`
by default. It does not read transcript files. Set
`AGENTOPS_HOOK_CAPTURE_PATH` to choose a different ignored local output path.

Inspect the templates before copying them:

```bash
ls templates/hooks
sed -n '1,160p' templates/hooks/write-hook-envelope.mjs
sed -n '1,120p' templates/hooks/codex/hooks.json
sed -n '1,120p' templates/hooks/claude/settings.json
```

For Codex, copy the helper and hook configuration into a trusted project after
review:

```bash
mkdir -p .agentops/hooks .codex
cp templates/hooks/write-hook-envelope.mjs .agentops/hooks/
cp templates/hooks/codex/hooks.json .codex/hooks.json
```

Codex requires hook review/trust before non-managed command hooks run. Use the
Codex hook review flow to inspect and trust the copied commands.

For Claude Code, copy the helper and merge the settings template manually:

```bash
mkdir -p .agentops/hooks .claude
cp templates/hooks/write-hook-envelope.mjs .agentops/hooks/
cp templates/hooks/claude/settings.json .claude/settings.json
```

If `.claude/settings.json` already exists, merge the `hooks` object instead of
overwriting the file.

Command hooks run with your user permissions. Keep them opt-in, local-only, and
easy to remove. Delete the copied settings entry and helper script to disable
the template.

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
