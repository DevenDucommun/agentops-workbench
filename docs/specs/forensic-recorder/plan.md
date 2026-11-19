# Plan: Forensic Recorder

Status: **proposed**. Implements [spec.md](spec.md). Tasks: [tasks.md](tasks.md).

## Existing code paths and boundaries

| Area | Today | Change |
|------|-------|--------|
| Ingestion | `src/adapters.ts`, `src/claudeStream.ts`, `src/codexExec.ts`, `src/forensicText.ts`, `src/parser.ts` | New `claude-hooks` adapter reads spool files; the existing adapters stay unchanged |
| Capture | `src/capture.ts` wraps CLI runs | Unchanged. The recorder is a separate path (`src/recorder/`) |
| Store | `src/store.ts`, SQLite tables `sessions`, `events`, `commands`, `file_changes`, `tool_calls`, `risk_flags`, with `addColumnIfMissing` migrations | Additive columns (event chain fields, session chain head, commit links) and a new `session_commits` table |
| Analysis | `src/analyzer.ts` (risk flags, evidence claims), `src/gate.ts` | Claims ledger, retry/stall rules, blocked-attempt policy |
| Redaction | `src/redaction.ts` (`sha256`, secret patterns) | Reused at write time by the recorder |
| Git | `src/git.ts` (status/numstat) | Blame and commit lookup helpers |
| Export | `src/export.ts` (OpenInference JSON) | Bundle and OTLP writers |
| Output | `src/report.ts`, `src/dashboard*.ts`, `src/mcp.ts` | Ledger, provenance, verify and trends sections; MCP tools for lookups |
| Docs | `docs/EVENT_SCHEMA.md`, `CAPTURE_GUIDE.md`, `COMPATIBILITY.md`, `CLI.md`, `PUBLICATION_AND_PRIVACY.md` | Updated in the same PR as each feature |

## Delivery chunks (one PR each, reviewable on their own)

### Phase 0: Spikes (no product code merged)

- **S1 Claude hook capture spike.** Install a throwaway hook that dumps
  payloads for every hook event in a scratch repo. Record field names, the
  tool response shapes, subagent identifiers and session end reasons. Measure
  cold-start latency of the release binary vs. a minimal writer. Output:
  `docs/specs/forensic-recorder/spike-s1.md` and synthetic fixtures based on
  the real field shapes (values replaced).
- **S2 Codex capture spike** (can run in parallel, does not gate M1). Output:
  a decision note.

### M1: Recorder (target v3.3.0)

1. **Schema and store groundwork.** Optional v1 fields (`eventId`, `seq`,
   `prevHash`, `hash`, `cwd`, `gitHead`, `toolUseId`, `parentToolUseId`,
   `agentId`, `contentHash`), canonical JSON hashing helper, store columns,
   and a `session_commits` table. Docs: EVENT_SCHEMA, COMPATIBILITY. No
   behavior change for existing inputs.
2. **Spool writer.** `src/recorder/spool.ts`: per-session file, `O_APPEND`
   writes, a `seq` counter recovered from the file tail, chain hashing,
   redaction at write time, a size cap, and error records. Pure library plus
   unit tests (concurrency, failure injection, secret grep).
3. **Hook entrypoint.** `agentops hook <event>` reads the hook JSON on stdin,
   checks enrollment, writes the spool and exits 0 within the time budget.
   This PR adds the latency benchmark (`smoke:recorder`). If S1 shows the
   binary cold start is over budget, it ships the minimal writer from S1
   instead.
4. **`claude-hooks` adapter and session-end ingest.** Spool to normalized
   events to store and analyzer. Commit SHA linking (R1.8). Optional verdict
   line.
5. **Plugin packaging and enrollment.** `plugin/` with the plugin manifest,
   `hooks/hooks.json` and the marketplace manifest.
   `agentops recorder enable|disable|status`. CAPTURE_GUIDE and README
   install section.
6. **Release v3.3.0** after the dogfood gate.

### M2: Evidence ledger (target v3.4.0)

1. Ledger model and `contradicted` logic, building on `evidenceClaimRules`.
   Claims link to `eventId`s; legacy sessions without IDs fall back to row
   IDs.
2. New claim categories (callers/usages, on-device/in-browser verification,
   "fixed"), each with fixtures.
3. Retry/stall rules (the v3.2 carry-over).
4. Blocked-attempt policy and gate threshold. Document every gate result
   change on existing fixtures in the CHANGELOG.
5. Report, dashboard and PR-comment rendering of the ledger.

### M3: Provenance (target v3.5.0)

1. Git helpers: blame porcelain parsing and commit lookups.
2. Line-hash index from recorded edits (`contentHash` plus per-line hashes
   for the edited range).
3. `agentops blame`, `agentops commits`, `agentops session --commit` and
   matching MCP lookup tools.
4. Optional `prepare-commit-msg` trailer hook (`agentops recorder
   git-trailer enable`).

### M4: Integrity (target v3.6.0)

1. `agentops verify` over the store and spools, plus the session chain head
   recorded at analysis.
2. Evidence bundle writer and `verify --bundle`.

### M5: Telemetry (target v3.7.0)

1. Trends aggregation queries and `agentops trends`.
2. Dashboard trends view.
3. `agentops save otlp` plus `smoke:otlp` (collector import).

### After M5 (re-sequenced from the old roadmap)

- Team policy packs (old v3.3). These can now include recorder and ledger
  rules.
- LLM judge (old v3.4). It sits on top of the M2 ledger and only cites
  ledger events.
- Codex automatic capture (if S2 shows a documented surface).

## Dependency graph

```text
S1 ──> M1.1 ──> M1.2 ──> M1.3 ──> M1.4 ──> M1.5 ──> v3.3.0
                  │                          │
                  │                          ├──> M2 (ledger, needs eventIds) ──> v3.4.0
                  │                          ├──> M3 (provenance, needs contentHash + commit links) ──> v3.5.0
                  └──────────────────────────┴──> M4 (integrity, needs chain fields) ──> v3.6.0
M5 (telemetry) needs only stored sessions; it can start after M1.4, and richer metrics land as M2/M3 ship.
```

M2, M3 and M4 do not depend on each other. Once M1 ships they can run in
parallel. The release order above is the recommended order: the ledger gives
the most value to day-to-day review, provenance is the main forensic feature,
and integrity matters most once records are used as evidence.

## Compatibility, migration and rollback

- **Schema.** Only optional fields are added to `agentops.event.v1`. Old JSONL
  imports unchanged. Store migrations are additive (`addColumnIfMissing`,
  `CREATE TABLE IF NOT EXISTS`), so older binaries ignore the new columns.
- **Gate behavior.** M2 changes flag severities (blocked attempts) and adds
  flags. Every change to a gate outcome on existing fixtures is listed in
  the CHANGELOG with the config key that restores the old behavior.
- **Recorder rollback.** `agentops recorder disable` or uninstalling the
  plugin stops capture at once. Spools stay on disk until the user removes
  them, and are documented in PUBLICATION_AND_PRIVACY.
- **Hook failure mode.** Always exit 0. The worst case is a missing record,
  never a blocked agent.

## Acceptance criteria to steps

| AC | Steps |
|----|-------|
| AC1 | M1.3, M1.4, M1.5 |
| AC2 | M1.3, M1.5 |
| AC3 | M1.2 (writer), M1.4 (store) |
| AC4 | M1.2, M1.3 (`smoke:recorder`) |
| AC5 | M1.1, M1.2 |
| AC6 | M1.4 |
| AC7 | M2.1, M2.2 |
| AC8 | M2.3, M2.4 |
| AC9 | M3.1 to M3.3 |
| AC10 | M4.1 |
| AC11 | M4.2 |
| AC12 | M5.1, M5.3 |

## Deferred on purpose (do not expand scope)

- Codex automatic capture, Windows, a remote evidence store, signing bundles
  with user keys (hash-only manifests first), live tailing (`agentops
  watch`), and blame across renames beyond what `git blame -M` gives.
