# Tasks: Forensic Recorder

Status: **proposed**. Ordered by dependency. Each task produces an artifact
and lands through a PR with `bun run ci` green. "Verify" lines name the proof.
Sizes are relative effort: S, M or L.

## Phase 0: Spikes

- [x] **T0.1 (M) S1 hook capture spike.** Artifact: [`spike-s1.md`](spike-s1.md) (hook
  events, payload fields per event, subagent IDs, end reasons, tested Claude
  Code version, latency of binary vs. minimal writer, recommended budget).
  Verify: the field table cites real payload captures; real values are not
  committed.
- [x] **T0.2 (S) Synthetic hook fixtures.** Artifact:
  [`fixtures/claude-hooks/*.jsonl`](../../../fixtures/claude-hooks/) (clean session, risky session, subagent
  session, failing-test session, commit session). Verify: `bun run
  scan:public` clean.
- [x] **T0.3 (S) S2 Codex capture decision note.** Artifact:
  [`spike-s2.md`](spike-s2.md). Does not block M1.

## M1: Recorder (v3.3.0)

- [x] **T1.1 (M) Schema fields and hashing helper.** Optional v1 fields,
  canonical JSON hash, EVENT_SCHEMA and COMPATIBILITY docs. Verify: existing
  fixture imports produce byte-identical reports (golden test).
- [x] **T1.2 (S) Store migration.** Chain and provenance columns plus the
  `session_commits` table. Verify: migration test from a v3.2 database.
- [x] **T1.3 (M) Spool writer library.** Verify: tests for concurrency (two
  writers, continuous `seq`, valid chain) (AC5), secret grep (AC3), and an
  unwritable directory (AC4).
- [x] **T1.4 (M) `agentops hook <event>` entrypoint plus enrollment check.**
  Verify: malformed stdin, missing enrollment (AC2) and exit code are always
  0. `smoke:recorder` reports p95 latency under budget (AC4).
- [x] **T1.5 (M) `claude-hooks` adapter and session-end ingest.** Verify:
  T0.2 fixtures ingest. `look` shows tool calls, files and commands. The
  commit fixture links its SHA (AC6).
- [x] **T1.6 (S) Optional turn-end verdict line.** Verify: off by default;
  when on, the Stop hook prints one `systemMessage` line and never a non-zero
  exit. (Moved from session end: Claude Code discards SessionEnd output.)
- [x] **T1.7 (M) Plugin packaging.** `plugin/` manifest, hooks config,
  marketplace manifest, `agentops recorder enable|disable|status`, and
  CAPTURE_GUIDE/README. Verify: manual install in a scratch repo, then an
  interactive session appears in `agentops sessions` (AC1).
- [ ] **T1.8 (S) Privacy and release docs.** PUBLICATION_AND_PRIVACY (spool
  location, retention, removal) and RELEASE_CHECKLIST recorder items.
- [ ] **T1.9 (S) Dogfood gate, then release v3.3.0.** Verify: one week of
  enrolled use, `agentops verify` (preview) clean, no hook errors, release
  smoke passes.

## M2: Evidence ledger (v3.4.0)

- [x] **T2.1 (M) Ledger model with supported/unsupported/contradicted and
  event citations.** Verify: AC7 fixtures (pass, fail then claim, no run then
  claim, fail then pass then claim).
- [ ] **T2.2 (M) New claim categories** (callers/usages, on-device or
  in-browser verification, "fixed"). Verify: one positive and one negative
  fixture per category.
- [ ] **T2.3 (M) Retry/stall rules.** Verify: AC8 fixtures, and the existing
  fixtures' gate results are unchanged.
- [ ] **T2.4 (S) Blocked-attempt policy plus gate threshold.** Verify: the
  declined destructive command fixture raises an info flag; CHANGELOG lists
  the behavior change and the config key that restores it.
- [ ] **T2.5 (M) Ledger rendering** in the report, dashboard and PR comment.
  Verify: demo artifacts regenerated (`smoke:demo-artifacts`).
- [ ] **T2.6 (S) Release v3.4.0.**

## M3: Provenance (v3.5.0)

- [x] **T3.1 (S) Git blame/commit helpers.** Verify: porcelain parser unit
  tests, commit metadata and trailers, and missing-Git behavior. Path-history
  traversal is tracked in [#152](https://github.com/DevenDucommun/agentops-workbench/issues/152).
- [ ] **T3.2 (M) Line-hash index from recorded edits.** Verify: index test on
  the commit fixture.
- [ ] **T3.3 (M) `agentops blame`, `commits`, `session --commit`, plus MCP
  lookups.** Verify: AC9 in a scripted temp repo (`exact`, `commit`, `none`).
- [ ] **T3.4 (S) Optional commit trailer hook.** Verify: off by default; when
  on, it adds the trailer only while a recorded session is active.
- [ ] **T3.5 (S) Release v3.5.0.**

## M4: Integrity (v3.6.0)

- [ ] **T4.1 (M) `agentops verify` over the store and spools, plus the
  session chain head.** Verify: AC10 (tampered row named, legacy session
  `unchained`).
- [ ] **T4.2 (M) Evidence bundle plus `verify --bundle`.** Verify: AC11
  (offline verify passes; a one-byte flip fails).
- [ ] **T4.3 (S) Release v3.6.0.**

## M5: Telemetry (v3.7.0)

- [ ] **T5.1 (M) Trends queries plus `agentops trends`.** Verify: AC12
  against hand-computed values on the synthetic multi-session store.
- [ ] **T5.2 (M) Dashboard trends view.** Verify: `smoke:dashboard`.
- [ ] **T5.3 (M) `agentops save otlp` plus `smoke:otlp`.** Verify: import
  into a local collector in the smoke test; redaction defaults covered.
- [ ] **T5.4 (S) Release v3.7.0.**

## Follow-ups (not required for completion)

- Team policy packs that include recorder and ledger rules.
- An LLM judge on top of the ledger.
- Codex automatic capture, depending on T0.3.
- Live tailing (`agentops watch`).
- Signed bundles with user keys.
