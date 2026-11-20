# Evidence Trust Model

Status: **proposed decision note**. Amends M2 ([spec.md](spec.md), R2.1–R2.2)
and sets the acceptance criteria for the open ledger and import PRs. Needs
owner approval before implementation.

## Problem

The gate decides whether a session's final claims ("tests pass", "lint is
clean") are backed by evidence. Today it reaches that verdict by inferring
three things from unstructured text:

1. **Transcript structure:** where the final answer starts and ends in a
   pasted plain-text log, and which lines are command output.
2. **What a shell string ran:** whether `env -u CI npx -c 'bun test' && …`
   ran a test, and which exit code belongs to it.
3. **What a sentence claims:** clauses, negation ("not only passed"),
   summaries versus bodies.

Each of these is open-ended. During review of the M2 ledger (#140) and the
import fixes (#148), every round fixed the reported inputs and the new rules
opened new ones: four review rounds on #140 and seven on #148, with most late
findings caused by the previous round's heuristic. The structured paths (hook spools,
provider JSON with real exit codes, git reads) produced mechanical bugs that
were fixed once and stayed fixed.

The gate cannot be made correct by adding parsing rules. It can be made
correct by never letting an inference produce a pass.

## Decision

### 1. Two evidence tiers

| Tier | What qualifies | Examples |
|---|---|---|
| **Observed** | A single command or tool call with its own recorded outcome, from a structured source | Recorder spool `PostToolUse` / `PostToolUseFailure`; Claude stream `tool_use` matched to its `tool_result` by id; Codex exec `item.completed` with `exit_code`; generic JSONL events that carry `exitCode` or a terminal `status` |
| **Inferred** | Anything derived from text or from parsing a shell string | Plain-text imports (`$ cmd` lines, `exit code N` prose); commands only mentioned in prose; a compound or wrapped shell string; a tool call with no result |

Existing fields already carry this: `provenance: "inferred"` and
`confidence` on events. The ledger reads them instead of re-deriving trust.

### 2. Gate rules

| Ledger verdict | Evidence | Gate |
|---|---|---|
| `supported` | Latest matching **observed** run passed | passes |
| `contradicted` | Latest matching **observed** run failed, no later observed pass | fails |
| `unsupported` | No matching run of any tier | fails |
| `unverified` *(new)* | Only **inferred** matching evidence | fails as `unverified-claims` by default; `gates.allowUnverifiedClaims` downgrades it to a review note |

**Unknown is never a pass.** A missing result, an ambiguous boundary or a
command whose outcome cannot be attributed is at most `unverified`.

### 3. Command matching is exact, not parsed

- A run matches a claim kind when the command is a **simple command** (no
  `;`, `&&`, `||`, `|`, `&`, `$(`, backticks or newlines after stripping
  leading `VAR=value` assignments) and its leading words match one of the
  kind's configured patterns (`bun test`, `npm run lint`, `tsc`, …).
- Anything else that mentions a verification command is **inferred**: no
  wrapper unwrapping, no option tables, no compound-command attribution.
- Users who run tests through wrappers add the exact wrapper form to the
  configured patterns.

### 4. Claim detection over-detects

- A sentence that contains a claim kind's success vocabulary is a claim, even
  when it is negated or hedged. Missing a claim can produce a false pass;
  flagging one twice cannot.
- The final response is checked in full (`events.text`, falling back to the
  summary), and a producer's explicit summary is checked as well.
- Plain-text imports: claims are detected across all non-`User:` text, not a
  heuristically bounded "final answer". Their evidence is inferred, so their
  claims are at most `unverified`, and boundary rules no longer affect the
  verdict.

### 5. The recorder is the primary source

M1 sessions carry observed evidence for every tool call, so they get real
pass/fail verdicts and rarely reach `unverified`. Text import stays supported
for history and forensics, documented as the weaker path. Product docs and
`agentops audit` output say which tier a session's evidence came from.

### 6. Roadmap: structured claims

Natural-language claim detection remains the weakest link. A later task adds
an optional **claim manifest**: a fenced JSON block at the end of the final
response listing `{ kind, command }` pairs, requested through repository
instructions (`CLAUDE.md` / `AGENTS.md`), not through a hook. Hooks may not
intervene in the session ([spec.md](spec.md) non-goals). When a manifest is
present, it replaces sentence parsing for that session; without one, rule 4
applies.

## Review policy

Reviews of M2 and import changes use these acceptance criteria:

- **Blocking:** a regression against the PR's base; a false pass (any path by
  which inferred or unknown evidence yields `supported` or a passing gate);
  data loss (sessions, events, files or links dropped); behavior that
  contradicts the documentation.
- **Non-blocking, filed as follow-ups:** new edge cases in inferred-tier
  parsing, cosmetic or display differences, and stricter-than-necessary
  verdicts (`unverified` where a human would say `supported`).

## Effect on open work

| PR | Keeps | Drops or changes |
|---|---|---|
| #140 ledger (T2.1) | Verdict ledger; Claude `tool_result` correlation; results after the final response not counting; `COALESCE(text, summary)` | Removes shell unwrapping (`env -S`, `npx -c`), wrapper option tables, compound-command attribution and negation handling; adds the `unverified` verdict and rule 3 |
| #141–#144 (T2.2–T2.5) | Claim kinds, retry/stall rules, rendering | Re-synced onto the simplified #140; device and browser claims follow rule 3 with configured patterns |
| #148 import fixes | Empty Action input, collision-free fallback ids, NUL-delimited git parsing with byte-safe decoding, `events.text`, git error surfacing (with `LC_ALL=C`) | Plain-text boundary heuristics revert to the reviewed state; rule 4's plain-text detection lands with the trust-model task |
| #149 | `--base`, command pairing, embedded demo fixtures | Retargeted to `main` after #148 merges instead of carrying #148's changes |
| #147 provenance helpers (T3.1) | Blame, commit info, trailers, missing-git handling | Path history (`commitsTouching`) moves to a follow-up task |

New tasks:

- **T2.6** Implement the evidence tiers, the `unverified` verdict, rule 3 and
  rule 4, with fixtures for each tier and verdict.
- **T2.7** Spike: claim manifest format and its acceptance in the ledger.

## Assumption to verify

This model assumes most sessions that matter go through the recorder. If many
will always be pasted text or post-hoc Codex logs, `unverified` becomes
common, and T2.7 moves up. The T1.x dogfood week measures the share of
recorded sessions and the `unverified` rate.

## Open questions

1. Should `unverified` fail the gate by default (proposed), or warn by default
   with an opt-in to fail?
2. Should generic JSONL events without `exitCode` or a terminal `status` be
   observed (the producer chose the format) or inferred (proposed)?
