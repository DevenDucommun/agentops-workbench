# Demo Artifacts

These files are generated from synthetic fixtures and are safe to publish.

Regenerate them with:

```bash
bun run demo:artifacts
```

Check that tracked artifacts are current with:

```bash
bun run smoke:demo-artifacts
```

Artifacts:

- `sample-session-report.md`: Markdown report for a verified low-risk session.
- `sample-quality-gate.json`: Machine-readable passing quality gate result.
- `risky-quality-gate-comment.md`: GitHub-ready failing quality gate body for a risky session.
- `forensic-transcript-report.md`: Lower-fidelity forensic transcript report with evidence-quality labels.
