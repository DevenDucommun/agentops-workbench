# Quality Gates

AgentOps quality gates turn an imported session into a deterministic local or
CI pass/fail decision.

Gates read only the local SQLite store and current git metadata. They do not
upload transcripts, command output, raw event payloads, or reports.

## Basic Use

```bash
./bin/agentops audit ./fixtures/sample-session.jsonl
./bin/agentops check
```

The command exits with:

- `0` when all gates pass
- `1` when any gate fails

Machine-readable output:

```bash
./bin/agentops check --save
```

GitHub-ready comment body:

```bash
./bin/agentops save pr
```

The GitHub format is stdout/file only. The CLI does not post comments; the
[GitHub Action](#github-action) can, when you opt in.

## Default Gates

Default gates fail when:

- no observed verification command is recorded
- any high-severity risk is present
- more than `gates.maxBlockedAttempts` (default 2) risky commands were blocked
- final success or test/lint/typecheck/build claims are unsupported,
  contradicted, or only inferred from forensic text
- generated-file churn is above the configured threshold

Forensic inferred commands are review evidence, not observed proof.

## Claims Ledger

Each verification claim in the final response gets a verdict from the matching
runs (shell commands and tool calls) before it:

| Verdict | When | Risk flag |
| --- | --- | --- |
| `supported` | The latest matching run passed | none |
| `contradicted` | The latest matching run failed, and no later run passed | `contradicted-claim` |
| `unsupported` | No matching run was observed | `missing-<kind>-evidence` |

| Claim | Example wording | Matching runs | Kind |
| --- | --- | --- | --- |
| Tests pass | "all tests pass" | `bun test`, `pytest`, `cargo test`, ... | `test` |
| Lint is clean | "lint is clean" | `eslint`, `bun run lint`, ... | `lint` |
| Typecheck passes | "tsc is clean" | `tsc`, `bun run typecheck`, ... | `typecheck` |
| Build succeeds | "the build succeeded" | `bun run build`, `cargo build`, ... | `build` |
| No other callers | "there are no other callers", "not used anywhere" | `rg`, `grep`, `git grep`, or a Grep/search tool | `callers` |
| Verified on a device | "verified it on the router" | `ssh`, `adb`, `ubus`, `uci`, ..., or a device/router/serial tool | `device` |
| Verified in a browser | "checked it in the browser", "e2e tests pass" | `playwright`, `cypress`, ..., or a browser tool | `browser` |
| Fixed | "fixed", "resolved", "now works" | a verification command after the last file edit | `fix` |

A run fails when it reports a non-zero exit code or a failed status. A search
that finds nothing (exit 1) still counts as a passing search; only search
errors fail. Denied, declined and inferred commands never count as runs. The
verdict cites the run it rests on by `eventId`, or by stored event row for
sessions recorded without event IDs. A claim that fails, then passes on a
re-run, is supported.

Before the ledger, any matching run supported a claim, including a failed one.
To keep that behavior, suppress the new flag:

```json
{ "suppressions": [{ "category": "contradicted-claim", "reason": "Accept claims after failing runs." }] }
```

## Retry And Stall Signals

Two review signals flag a session that went in circles. They never fail a gate
on their own (neither is high severity or a claim category), but they show up
with the other risks:

| Flag | When | Severity |
| --- | --- | --- |
| `retry-without-change` | The same command ran again after failing, with no file change in between | low for one retry, medium for two or more |
| `repeated-edits` | One file changed at least `risk.repeatedEditThreshold` times (default 6) | medium |

A failing test that is never re-run before a success claim is the ledger's
`contradicted` verdict above.

## Blocked Attempts

A destructive or permission-changing command that was denied (by a permission
rule or the user) or declined (by the agent runtime's approval policy) never
ran. It raises a low `blocked-attempt` flag instead of `destructive-command`
(high) or `permission-change` (medium). One blocked attempt is information:
the guardrail worked. Repeated attempts fail the `max-blocked-attempts` gate
once they exceed `gates.maxBlockedAttempts`.

Commands that ran are unchanged: an executed `rm -rf` is still a high
`destructive-command`. To count blocked commands as if they had run, as v3.2
did, set `risk.treatBlockedAsExecuted` to `true`.

## Configuration

Configure gates in `agentops.config.json`:

```json
{
  "schemaVersion": "agentops.config.v1",
  "gates": {
    "requireVerification": true,
    "requiredVerificationCommands": ["test", "lint"],
    "maxHighSeverityRisks": 0,
    "maxBlockedAttempts": 2,
    "allowUnsupportedFinalClaims": false,
    "maxGeneratedFileChurnLines": 20,
    "generatedFilePatterns": ["generated", "dist", "build"]
  }
}
```

`requiredVerificationCommands` checks observed verification command text. For
example, `"lint"` matches `bun run lint`.

`generatedFilePatterns` is a simple case-insensitive path substring match.

## GitHub Action

The repository is itself a GitHub Action. It installs a pinned AgentOps
release binary, audits each artifact, runs `agentops check --format github`,
writes the results to the job summary, and fails the job when any gate fails:

```yaml
name: AgentOps Gate

on:
  pull_request:

permissions:
  contents: read

jobs:
  agentops-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Produce or restore the agent run artifact here, for example:
      # codex exec --json "review the current diff" > codex-session.jsonl
      - uses: DevenDucommun/agentops-workbench@v3.2.0
        with:
          artifact: codex-session.jsonl
          version: v3.2.0
```

| Input | Default | Meaning |
| --- | --- | --- |
| `artifact` | required | Artifact paths or globs, newline- or space-separated. A path that matches nothing fails the gate. |
| `version` | `latest` | AgentOps release tag to install. Pin it for reproducible gates. |
| `agentops-path` | empty | Use an existing `agentops` executable instead of installing. |
| `config` | `agentops.config.json` | Config used by both `audit` and `check`. |
| `fail-on-gate` | `true` | Fail the job when any gate fails. |
| `comment` | `false` | Post or update one sticky PR comment with the result. Needs `pull-requests: write`. |
| `github-token` | `github.token` | Token used only for `comment`. |

Outputs: `status` (`passed` or `failed`), `failed` (count of failing
artifacts), and `report` (path to the combined Markdown report).

The CLI never posts to GitHub. Only the Action posts, and only with
`comment: true`. The sticky comment starts with `<!-- agentops-gate -->` and is
updated in place on later runs.

Artifacts are treated as untrusted input. The Action keeps its SQLite
databases and reports under `$RUNNER_TEMP`, never in the repository checkout,
and it never uses artifact content (such as session ids) in file paths,
command arguments, or log output. A malformed artifact fails only its own gate;
the remaining artifacts are still checked.

## Manual CI Workflow

Without the Action, a workflow can import an artifact, run the gates, and
upload only the generated reports:

```yaml
name: AgentOps Gate

on:
  pull_request:

jobs:
  agentops-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: ./bin/agentops audit ./fixtures/sample-session.jsonl
      - run: ./bin/agentops check --save
      - run: ./bin/agentops save pr
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: agentops-reports
          path: |
            agentops-gate.json
            agentops-pr-comment.md
```

Use ignored local paths such as `.agentops/captures/` for raw captures. Upload
sanitized gate/report outputs only when needed.
