# Clarify: Forensic Recorder

Status: `ready-for-spec` (with stated defaults). Date: 2026-11-19.

## Objective

Turn AgentOps from a tool you point at a capture you remembered to make into a
local forensic record of coding-agent work. Every agent session in an enrolled
repo is recorded automatically and redacted at write time. The record is
tamper-evident and can be queried afterwards. "Afterwards" means reviewing the
run, tracing a line of code back to the session that wrote it, checking
whether claims of success had evidence behind them, and seeing trends across
many sessions.

## Explicit requirements

1. Automatic capture of Claude Code sessions through a plugin that uses
   documented hooks, with no wrapper command.
2. Telemetry after the work: per-session verdict at session end, plus
   aggregate trends across sessions.
3. Forensics: provenance from commit and line back to session and tool call,
   claims linked to evidence, and an integrity check.

## Implied requirements

- Recording never breaks, blocks or noticeably slows the agent. Hooks always
  exit 0 within a bounded time.
- Hook payloads contain full file contents and command output, so redaction
  must happen before anything touches disk.
- Concurrent sessions must not corrupt each other's records.
- Existing `agentops.event.v1` consumers keep working. New fields are
  optional, as the compatibility policy allows.
- The existing pipeline stays the source of truth: spool, then adapter, then
  store, then analyzer. The recorder is a new input path, not a parallel
  system.
- Fixtures stay synthetic.

## Constraints

- Local-first. No network calls, no default upload endpoint.
- Product non-goals still hold. There is no live intervention: the end-of-
  session verdict is informational and never blocks or denies. Undocumented
  private transcript files are not parsed. Only the documented hook payloads
  are used.
- TypeScript, Bun and SQLite. Standalone binaries remain the distribution.

## Risks and unknowns

| ID | Unknown | How it gets resolved |
|----|---------|----------------------|
| U1 | Exact hook event set and payload fields in current Claude Code (tool response shape, subagent identifiers, session end reasons) | Spike S1: capture real payloads, then build synthetic fixtures from them |
| U2 | Hook latency budget: overhead of a Bun binary cold start for each tool call | Spike S1: measure p50/p95. Fallback is a tiny shell or append-only writer that defers parsing to ingest |
| U3 | Codex capture surface (notify hook vs. session log vs. `exec --json` only) | Spike S2, scheduled after the Claude path ships |
| U4 | Whether line-level blame can match reliably once humans edit agent-written lines | Prototype in the provenance milestone. Report the confidence level instead of claiming exact matches |
| U5 | Distribution: plugin marketplace manifest in this repo vs. a separate repo | Default: same repo, `plugin/` directory plus marketplace manifest |

## Defaults taken (change any of these before the spec is accepted)

- **Audience:** a public product, dogfooded on the maintainer's own sessions
  first. The Claude Code plugin comes before CI capture, because CI capture
  already exists through the v3.2 Action.
- **Ordering:** capture first, because every later feature needs recorder
  data.
- **Policy packs (old v3.3) and LLM judge (old v3.4) move after this work.**
  OTLP folds into the telemetry milestone.

## Blocking questions

None. The defaults above are reversible at the spec-review stage.
