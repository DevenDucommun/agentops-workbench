# Forensic Recorder

Status: **proposed**. Inputs: [clarify.md](clarify.md). Next: [plan.md](plan.md), [tasks.md](tasks.md).

## Objective

Make every coding-agent session in an enrolled repo produce a redacted,
tamper-evident, queryable record automatically. Use that record to answer five
forensic questions after the work is done:

1. What did this session do, and is it trustworthy? (existing reports, now automatic)
2. Did the agent's claims have evidence behind them, and where is it?
3. Which session and tool call produced this commit or line?
4. Has this record been altered since it was written?
5. Across many sessions, where do agents retry, stall, skip verification or get denied?

## Context

- Today capture is manual. Users run `agentops run claude|codex …`, pipe
  `codex exec --json` or `claude -p --output-format stream-json`, or import
  plain text. Interactive sessions are not recorded at all unless the user
  remembers to start them that way.
- The analyzer already detects test, lint, typecheck and build success claims
  (`src/analyzer.ts`, `evidenceClaimRules`). But it only flags their absence.
  It does not link a claim to the event that supports it.
- The README lists "Stalls/retries/loops", but no rule produces them yet
  (carried over from v3.2).
- Events have no stable IDs, ordering hash or provenance fields.
  `privacy.hashRawPayload` hashes payloads, but nothing chains events
  together.
- `agentops.event.v1` allows compatible optional fields, so no schema major
  version is needed.

## Requirements

### M1: Recorder (Claude Code plugin)

- **R1.1** A Claude Code plugin, shipped from this repo with a marketplace
  manifest, registers hooks for session start and end, prompt submit, tool use
  before and after (including failures), subagent stop and stop. Exact event
  names are confirmed by spike S1.
- **R1.2** Each hook appends one normalized record to a per-session spool file
  under a user-level state directory, never inside the repo checkout. Writes
  are append-only and safe when several sessions run at once.
- **R1.3** Redaction happens before the write. File contents and command
  output are stored as length plus `sha256` by default. Secrets are redacted
  with the existing `src/redaction.ts` rules. Raw content is stored only when
  `privacy.storeRawPayload` is on.
- **R1.4** Hooks always exit 0 and never print to the agent's context, except
  for the optional verdict in R1.6. Each hook has a time budget (target p95
  ≤ 50 ms, confirmed by S1). On internal error the hook writes an
  `agentops.recorder_error` record and exits 0.
- **R1.5** Records add optional v1 fields: `eventId`, `seq`, `prevHash`,
  `hash`, `cwd`, `gitHead`, `toolUseId`, `parentToolUseId`/`agentId`
  (subagents), and `contentHash` for file writes and edits. The chain fields
  are written from day one, even though verification ships in M4.
- **R1.6** At session end the spool is ingested through a new `claude-hooks`
  adapter, analyzed and stored. With `recorder.verdict: true`, the hook prints
  a one-line gate summary. It is informational only and never blocks the
  session.
- **R1.7** Enrollment is opt-in for each repo (`agentops recorder enable` /
  `disable` / `status`). Repos that are not enrolled record nothing.
- **R1.8** Successful `git commit` and `git push` tool calls record the
  resulting HEAD SHA, which links the session to its commits.

### M2: Evidence ledger

- **R2.1** Each detected claim in the final response (existing
  test/lint/typecheck/build rules, plus "no other callers/usages",
  "verified on device/in browser", "fixed") gets a verdict: `supported`
  (cites event IDs), `unsupported` (no matching evidence) or `contradicted`
  (the latest matching evidence failed).
- **R2.2** A claim counts as contradicted when the most recent matching
  verification command failed and no later run passed.
- **R2.3** Retry and stall rules: the same command re-run after a failure with
  no edit in between, repeated edits to the same file over a threshold, and a
  failing test never re-run before a success claim.
- **R2.4** Declined-command policy: a declined or denied destructive command
  becomes an informational `blocked-attempt` flag, not a high-severity
  failure. A configurable gate threshold covers repeated blocked attempts.
- **R2.5** Reports and the dashboard show the ledger with event links.

### M3: Provenance

- **R3.1** `agentops blame <path>[:line]` resolves the line through
  `git blame`, then the commit, the session(s) linked by R1.8 or a trailer,
  and finally the file edit event(s) whose `contentHash`/line hashes match.
  Each answer carries a confidence label: `exact` (the line text hash matches
  the recorded edit), `commit` (the commit is linked but the line was changed
  since) or `none`.
- **R3.2** `agentops commits --session <id>` and `agentops session --commit
  <sha>` give a two-way mapping.
- **R3.3** An optional git `prepare-commit-msg` hook adds an
  `AgentOps-Session: <id>` trailer while a recorded session is active. It is
  off by default.

### M4: Integrity

- **R4.1** `agentops verify [--session <id>]` recomputes the hash chain over
  stored and spooled records. It reports the first broken link, missing `seq`
  gaps, and records with no chain fields (legacy sessions get the label
  `unchained`, not `failed`).
- **R4.2** `agentops save bundle --session <id>` writes a self-contained
  evidence bundle: redacted events, report, gate result, verify result and a
  manifest with hashes. `agentops verify --bundle` checks it offline.
- **R4.3** The analyzer records the chain head hash with each session, so a
  later change to stored rows can be detected.

### M5: Telemetry

- **R5.1** `agentops trends [--repo] [--agent] [--since]` computes, per
  period: sessions, verification rate, unsupported or contradicted claim
  rate, retry/stall rate, blocked attempts, gate pass rate, tokens and cost,
  and cost per linked commit.
- **R5.2** The dashboard gets a trends view built from the same data.
- **R5.3** `agentops save otlp` writes OTLP/JSON spans following the GenAI
  semantic conventions, with `agentops.*` attributes, to a file only. The
  `--endpoint` upload stays gated on a user request, as before. This absorbs
  the old v3.5.

## Non-Goals

- Blocking, denying or modifying agent actions (no live intervention).
- Network upload by default, a hosted service or multi-user features.
- Parsing undocumented transcript files. Only documented hook payloads are
  used.
- Codex automatic capture in M1 (spike S2 decides whether a later milestone
  covers it).
- LLM-based judgement (the old v3.4 judge stays after M5, on top of the M2
  ledger).
- Windows support for the recorder.

## Acceptance Criteria

| ID | Criterion | Requirement |
|----|-----------|-------------|
| AC1 | With the plugin installed and the repo enrolled, an interactive Claude Code session appears in `agentops sessions` with no manual command, and `agentops look --session latest` shows its tool calls, files and commands | R1.1, R1.2, R1.6, R1.7 |
| AC2 | A non-enrolled repo produces no spool file | R1.7 |
| AC3 | A synthetic secret written through Write/Bash never appears in plaintext in the spool or the SQLite store (grep test) | R1.3 |
| AC4 | A hook given malformed input, an unwritable spool or a full disk exits 0 and leaves the agent unaffected; p95 hook latency in the benchmark is under the S1 budget | R1.4 |
| AC5 | Two concurrent synthetic sessions produce two intact spools with continuous `seq` and valid chains | R1.2, R1.5 |
| AC6 | A session that runs `git commit` is linked to the resulting SHA | R1.8 |
| AC7 | On fixtures, each claim gets the right verdict: passing test, failing test then claim, no test then claim, and fail then pass then claim | R2.1, R2.2 |
| AC8 | Retry/stall fixtures raise the new flags; the existing fixtures' gate results are unchanged except where documented | R2.3, R2.4 |
| AC9 | `agentops blame` returns `exact` for an agent-written, unmodified line; `commit` after a human edits it; `none` for a human-only line | R3.1 |
| AC10 | Editing one stored or spooled record makes `agentops verify` fail and name it; a legacy imported session reports `unchained` | R4.1, R4.3 |
| AC11 | A bundle verifies offline on a clean machine; flipping one byte fails verification | R4.2 |
| AC12 | `agentops trends` over a synthetic multi-session store matches hand-computed values; OTLP output imports into a local collector in the smoke test | R5.1, R5.3 |

## Risks

- **Hook latency** (U2). The mitigation is a minimal append-only writer;
  parsing waits for ingest.
- **Privacy regression.** Hook payloads are much richer than today's inputs.
  Redaction at write time, AC3 and the publication scan apply to every
  milestone.
- **Upstream hook churn.** Payload shapes change between Claude Code
  releases. Fixtures are pinned to versions, the adapter tolerates unknown
  fields, and the compatibility doc lists tested versions.
- **False confidence in blame.** Confidence labels are required, and `exact`
  needs a hash match.
- **Scope creep.** Each milestone is shippable on its own. Telemetry has no
  dependency on provenance or integrity.

## Verification

- `bun run ci` (typecheck, lint, tests, demo artifact smoke, publication
  scan) is green on every PR.
- Each AC has at least one named test under `test/`, with synthetic fixtures
  under `fixtures/`.
- New smoke scripts: `smoke:recorder` (hook latency, concurrency, failure
  injection) and `smoke:otlp` (collector import, M5).
- Dogfood gate before each release: one week of real sessions with the
  recorder enabled. `agentops verify` stays clean, and there are no agent
  slowdowns or hook errors visible in the session.
- Release checklist (`docs/RELEASE_CHECKLIST.md`) gains recorder and
  privacy items.
