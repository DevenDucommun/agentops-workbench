# Repo Report

`repo-report` compares an ingested agent session with the current local git diff.

The Markdown repo report and GitHub-format stdout output are stable local
report surfaces in `v1.0.0`. The command does not post comments or call GitHub.

```bash
agentops ingest ./fixtures/sample-session.jsonl
agentops repo-report --session latest > repo-report.md
agentops repo-report --session latest --format github > pr-comment.md
```

## What It Shows

- current git changed files
- files the agent touched during the selected session
- git changes that were observed in the session
- git changes that were not observed in the session
- agent-touched files that are no longer present in the current git diff
- verification commands
- risk flags
- commands run

## Why It Matters

Session reports answer "what did the agent do?"

Repo reports answer "does the current repo diff line up with what the agent did?"

This is the first PR-review-oriented report mode. It remains local-only and does not call GitHub.

## GitHub Comment Format

`--format github` emits a compact Markdown body suitable for a pull request comment.

The command only writes to stdout. It does not post to GitHub.

## Current Limitations

- Untracked files appear without line churn because git does not have a tracked base for them.
- Rename handling is intentionally basic in the MVP.
- The report compares paths exactly; future versions may add rename and generated-file awareness.
- The command reads local git state only. It does not post comments or inspect remote pull requests.
