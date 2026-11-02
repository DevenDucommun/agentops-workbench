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
- final success or test/lint/typecheck/build claims are unsupported or only
  inferred from forensic text
- generated-file churn is above the configured threshold

Forensic inferred commands are review evidence, not observed proof.

## Configuration

Configure gates in `agentops.config.json`:

```json
{
  "schemaVersion": "agentops.config.v1",
  "gates": {
    "requireVerification": true,
    "requiredVerificationCommands": ["test", "lint"],
    "maxHighSeverityRisks": 0,
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
      - uses: DevenDucommun/agentops-workbench@main  # pin a release tag once one includes the action
        with:
          artifact: codex-session.jsonl
          version: v3.1.0
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
