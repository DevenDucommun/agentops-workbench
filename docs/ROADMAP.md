# Roadmap: v3.2 and later

Status: **proposed**. Nothing below is committed until it has a tracking issue
and a milestone. Last reviewed: 2026-11-02.

The v1.x–v3.1 roadmaps are complete and archived in
[docs/archive/ROADMAP.md](archive/ROADMAP.md) and
[docs/archive/ROADMAP_POST_1_0.md](archive/ROADMAP_POST_1_0.md). This roadmap
starts from that archive's "Later Candidates" list.

## Product direction (unchanged)

AgentOps stays a narrow, local-first tool that answers one question: is this
coding-agent run trustworthy enough to review, merge, or hand off? It
complements full LLM observability platforms with repo-aware engineering
evidence. It does not replace them.

Every milestone below keeps these defaults:

- Local by default. Nothing uploads unless the user explicitly configures it.
- Deterministic evidence first. Any model-based judgement sits on top of
  recorded evidence and cites it.
- Synthetic or redacted fixtures only.

## Maintenance in flight (v3.1.x)

- Dependency catch-up: Biome 2, TypeScript 7, and Dependabot moved to the `bun`
  ecosystem so lockfile updates stop failing CI.
- Adapter refresh: the Codex exec and Claude Code stream adapters are rechecked
  against current CLI output (Codex 0.166, Claude Code 2.1), with
  schema-accurate fixtures.

## v3.2.0: `agentops check` as a GitHub Action (proposed)

**Why first:** this is the cheapest way for outside users to adopt AgentOps.
Today `check --format github` already produces a PR-ready gate result, but
every user has to wire up the install, the audit and the failure handling
themselves.

**Scope:**

- A composite action (`action.yml` at the repo root) usable as
  `uses: DevenDucommun/agentops-workbench@v3`.
- Inputs: `artifact` (path or glob to a Codex/Claude JSONL capture),
  `version` (AgentOps release to install; defaults to `latest`, pin it for
  reproducible gates),
  `config` (optional `agentops.config.json`), and `comment` (`false` by default).
- Steps: install the pinned standalone binary, run
  `agentops audit <artifact> --quiet`, run `agentops check --format github`,
  write the result to `$GITHUB_STEP_SUMMARY`, and exit non-zero when the gate
  fails.
- Opt-in PR comment (`comment: true`, which requires `pull-requests: write`)
  that updates one sticky comment instead of adding a new one per run. The CLI
  itself still never posts.
- An example workflow that captures a run with `agentops run …` or
  `codex exec --json` and then gates on it.

**Done when:** the action runs green on this repo's own CI against a synthetic
fixture, and fails the job on a fixture that should be blocked
(`fixtures/risky-session.jsonl`). The README shows the five-line usage.

Also in v3.2, closing gaps between the docs and what ships:

- **Retry and stall detection.** The README lists "Stalls/retries/loops" as a
  report section, but no analyzer rule produces it today. Add deterministic
  rules for the same command re-run after a failure, repeated edits to the
  same file, and a failing test that is never re-run before a success claim.
- **Declined-command policy.** Codex marks commands the sandbox or user
  blocked as `declined`. Decide whether a declined destructive command should
  stay a high-severity gate failure or drop to an informational flag.

## v3.3.0: Team policy packs (proposed)

**Why:** sensitive paths, required verification commands, and suppressions
live in one local config file, and the risk patterns are hardcoded in
`src/analyzer.ts`. Teams can't share or stack rules.

**Scope:**

- A versioned policy-pack format (`agentops.policy.v1`) containing sensitive
  paths, production paths, required verification commands, gate thresholds,
  suppressions, and custom risk patterns (regex plus severity plus category).
- `extends` in `agentops.config.json` to stack packs from local paths. Later
  config wins, and every rule records which pack it came from.
- Built-in starter packs, for example `node-service`, `python-service`,
  `infra-terraform` and `firmware`.
- `agentops config --check` explains the merged result and where each rule
  came from.

**Done when:** a repo can extend two packs, override one rule, and see in the
report which pack raised each risk. Migrating an existing config is
documented, and existing configs work unchanged.

**Not in scope:** fetching packs over the network or from a registry.

## v3.4.0: Evidence-backed review (proposed)

**Why:** deterministic gates catch missing evidence. They can't judge whether
the evidence actually supports the agent's claims. This was "LLM-as-judge
evaluation backed by deterministic evidence" in the archived later list.

**Scope:**

- `agentops judge [--session …]` is opt-in and off by default, and needs an
  explicitly configured model provider.
- The judge receives only the stored, already-redacted evidence: commands,
  exit codes, file changes, risk flags, and final claims. It never receives
  raw payloads.
- Output is structured: per-claim verdicts (`supported`, `unsupported`,
  `contradicted`), each of which must cite stored event IDs. A verdict with no
  citations is discarded and reported as "no judgement".
- Judge results are saved as a separate report section and never change the
  deterministic gate result unless a policy pack explicitly enables it.

**Done when:** the judge returns schema-valid, cited verdicts on the synthetic
fixtures, the discard rule for citation-free verdicts is tested, and a run
with judge disabled is byte-for-byte unchanged.

## v3.5.0: OTLP export (proposed, gated on demand)

**Why:** `save json --format openinference` already writes an
OpenInference-style JSON span bundle. OTLP would let AgentOps evidence flow
into existing trace backends.

**Gate:** start this only when at least one user asks for collector
ingestion. The archived roadmap set the same condition, and it still holds.

**Scope:**

- `agentops save otlp` writes OTLP/JSON to a file. Mapping follows the
  OpenTelemetry GenAI semantic conventions, with AgentOps risk and
  verification attributes namespaced under `agentops.*`.
- Optional `--endpoint` upload, only when explicitly configured. No default
  endpoint, no background upload.

**Done when:** exported spans import cleanly into a local collector in a smoke
test, and the redaction defaults are covered by tests.

## Still not planned

Carried over from the archived "Later Candidates" and non-goals, unchanged:

- Hosted dashboard or SaaS, multi-user auth.
- Direct integrations with issue trackers or incident tools.
- Live intervention in active agent runs.
- Parsing undocumented private transcript files as a stable feature.
- Replacing LangSmith, Langfuse, Phoenix, or other full observability systems.

Live read-only tailing (`agentops watch`) was deferred in v1.1. It stays a
candidate, to revisit after v3.2 if Action users ask for it.
