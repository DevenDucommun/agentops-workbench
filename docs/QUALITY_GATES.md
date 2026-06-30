# Quality Gates

AgentOps quality gates turn an imported session into a deterministic local or
CI pass/fail decision.

Gates read only the local SQLite store and current git metadata. They do not
upload transcripts, command output, raw event payloads, or reports.

## Basic Use

```bash
./bin/agentops import ./fixtures/sample-session.jsonl
./bin/agentops gate latest
```

The command exits with:

- `0` when all gates pass
- `1` when any gate fails

Machine-readable output:

```bash
./bin/agentops gate latest --format json --out agentops-gate.json
```

GitHub-ready comment body:

```bash
./bin/agentops gate latest --format github --out agentops-gate-comment.md
```

The GitHub format is stdout/file only. AgentOps does not post comments.

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

## GitHub Actions

AgentOps remains local-first in CI. A minimal workflow can capture or restore a
session artifact, import it, run gates, and upload only generated reports:

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
      - run: ./bin/agentops import ./fixtures/sample-session.jsonl
      - run: ./bin/agentops gate latest --format json --out agentops-gate.json
      - run: ./bin/agentops repo-report latest --format github --out agentops-pr-comment.md
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
