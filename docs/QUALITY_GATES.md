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

Each test, lint, typecheck or build claim in the final response gets a verdict
from the runs recorded before it:

| Verdict | When | Risk flag |
| --- | --- | --- |
| `supported` | The latest relevant run is a passing run that can support the claim | none |
| `contradicted` | The latest relevant run failed | `contradicted-claim` |
| `unsupported` | No relevant run was observed | `missing-<kind>-evidence` |

A run counts only with its own recorded outcome: an exit code, an explicit
failed status (`failed`, `error`, `timed_out`, `cancelled`, `interrupted`,
`killed`, `aborted`), or, for Claude Code stream sessions, the `tool_result`
linked to the call. A status such as `completed` with none of these is not
evidence, so a tool call that only carries a command (an MCP lookup, a file
write), a generic command without an exit code, and Claude Code calls from
stores written before results were linked never count. A run fails when it
reports a non-zero exit code or a failed status. Denied, declined, inferred
and still-running commands never count. The verdict cites the run it rests on
by `eventId`, or by stored event row for sessions recorded without event IDs.
A claim that fails, then passes on a re-run, is supported.

Evidence is asymmetric, so no rule can hide a failure:

- **Against a claim:** any failed run whose command mentions the kind anywhere
  (`bun test`, `go test -run X`, `cd app && bun test`, `bun test > log`, a
  search for the words), or is one of the kind's configured commands
  (`bun run ci` when configured for tests), counts as a failing run, whatever
  its shape.
- **For a claim:** only a passing shell execution of one of the kind's
  configured commands, word for word, counts. A shell execution is a generic
  `command` event, or a tool call named exactly `Bash`, `shell`,
  `exec_command`, `local_shell` (or Codex's `functions.<name>` form), or with
  no tool name. MCP tools whose name merely ends in a shell word, file writes
  and other tools never count. Commands must be plain printable ASCII: a
  non-breaking space or tab never matches. The built-in lists include
  `bun test`, `npm test`, `npm run test`, `pytest`, `make test`,
  `bun run lint`, `tsc --noEmit`, `bun run build` and their package-manager
  equivalents. Extra arguments (`bun test a.test.ts`, `pytest -q`),
  environment assignments (`CI=1 bun test`, `MAKEFLAGS=n make test`), dry runs
  (`make test --just-print`), other scripts (`npm run TEST`) and wrappers
  (`sh -c '...'`, `npx tsc`) never support a claim. A repository that uses
  other forms lists them in `evidence.supportCommands` (see
  [CONFIGURATION.md](CONFIGURATION.md)); a kind listed there replaces its
  built-in list. Configured entries are trusted as written; only shell syntax, `!` negation and
  the non-executing flags `-h`, `--help`, `-V`, `--version`, `--dry-run`,
  `--list` and `--collect-only` are refused, and `agentops check --config`
  reports them; they never match.

A run counts only once its result is recorded before the final response: a
still-running command, a Claude Code tool call without a `tool_result`, or a
result recorded after the final response is not evidence. Runs are ordered by
when their outcome was recorded: on their own row when they carry an exit code
or failed status, otherwise at their linked result. For Claude Code, a `tool_result` belongs to
the most recent call with that id before it, and a call's outcome is its first
result, so reused ids never share outcomes.

Claim detection is response-level and errs toward finding claims. A kind is
claimed when its subject (for example "test" or "lint") and any of its success
words ("passed", "clean", "green", ...) both appear anywhere in the final
response or its summary, even when negated, hedged or in different sentences.
"Tests failed. Lint passed." therefore claims both tests and lint. The ledger
reads the full final response when the store has it, together with the stored
summary.

Before the ledger, any run that mentioned the kind supported a claim, including
a failed one and one with extra arguments (`bun test a.test.ts`). Two changes
restore parts of that behavior, and each restores only its own part:

- To accept a claim after a failing run, suppress the new flag:

  ```json
  { "suppressions": [{ "category": "contradicted-claim", "reason": "Accept claims after failing runs." }] }
  ```

- A suppression does not make a command a supporting run. A passing run whose
  command is not on the kind's support list (extra arguments, a different
  script) still leaves the claim unsupported and fails the gate. List every
  command that runs your checks in `evidence.supportCommands`
  ([CONFIGURATION.md](CONFIGURATION.md)), for example
  `{ "evidence": { "supportCommands": { "test": ["bun test", "bun test a.test.ts"] } } }`.

## Retry And Stall Signals

Two review signals flag a session that went in circles. They never fail a gate
on their own (neither is high severity or a claim category), but they show up
with the other risks:

| Flag | When | Severity |
| --- | --- | --- |
| `retry-without-change` | The same shell command started again after a run of it failed (non-zero exit, failed or timed out), with no applied file change in between. Runs without a recorded outcome, non-shell tools, and calls issued before the failure's result arrived do not count | low for one retry, medium for two or more |
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
