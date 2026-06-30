import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeSession } from "../src/analyzer";
import { loadAdapterInput, resolveAdapter } from "../src/adapters";
import { defaultConfig } from "../src/config";
import { evaluateQualityGate, formatGateGithub, formatGateJson } from "../src/gate";
import { generateMarkdownReport } from "../src/report";
import { ingestTranscript, openStore, type Store } from "../src/store";

type Artifact = {
  path: string;
  content: string;
};

const check = process.argv.includes("--check");
const repoRoot = resolve(import.meta.dir, "..");
const outDir = join(repoRoot, "docs", "demo");
const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-demo-artifacts-")), "agentops.db"));

try {
  const sampleSessionId = ingestFixture(store, "fixtures/sample-session.jsonl");
  const riskySessionId = ingestFixture(store, "fixtures/risky-session.jsonl");
  const forensicSessionId = ingestFixture(store, "fixtures/forensic-terminal-transcript.txt");

  const artifacts: Artifact[] = [
    {
      path: "README.md",
      content: demoReadme()
    },
    {
      path: "sample-session-report.md",
      content: generateMarkdownReport(store, sampleSessionId, defaultConfig)
    },
    {
      path: "sample-quality-gate.json",
      content: formatGateJson(evaluateQualityGate(store, sampleSessionId, defaultConfig, { gitChanges: [] }))
    },
    {
      path: "risky-quality-gate-comment.md",
      content: formatGateGithub(evaluateQualityGate(store, riskySessionId, defaultConfig, { gitChanges: [] }))
    },
    {
      path: "forensic-transcript-report.md",
      content: generateMarkdownReport(store, forensicSessionId, defaultConfig)
    }
  ];

  if (check) {
    checkArtifacts(artifacts);
  } else {
    writeArtifacts(artifacts);
  }
} finally {
  store.db.close();
}

function ingestFixture(store: Store, relativePath: string): string {
  const sourcePath = join(repoRoot, relativePath);
  const input = loadAdapterInput(sourcePath);
  const adapter = resolveAdapter(input);
  const transcript = adapter.parse(input, defaultConfig);
  const result = ingestTranscript(store, transcript, defaultConfig);
  analyzeSession(store, result.sessionId, defaultConfig);
  return result.sessionId;
}

function writeArtifacts(artifacts: Artifact[]): void {
  mkdirSync(outDir, { recursive: true });
  for (const artifact of artifacts) {
    writeFileSync(join(outDir, artifact.path), artifact.content);
  }
  console.log(`Generated ${artifacts.length} demo artifacts in docs/demo.`);
}

function checkArtifacts(artifacts: Artifact[]): void {
  for (const artifact of artifacts) {
    const target = join(outDir, artifact.path);
    if (!existsSync(target)) {
      fail(`Missing demo artifact: ${target}`);
    }
    const current = readFileSync(target, "utf8");
    if (current !== artifact.content) {
      fail(`Demo artifact is out of date: ${target}\nRun: bun run demo:artifacts`);
    }
  }
  console.log("Demo artifacts are up to date.");
}

function demoReadme(): string {
  return `# Demo Artifacts

These files are generated from synthetic fixtures and are safe to publish.

Regenerate them with:

\`\`\`bash
bun run demo:artifacts
\`\`\`

Check that tracked artifacts are current with:

\`\`\`bash
bun run smoke:demo-artifacts
\`\`\`

Artifacts:

- \`sample-session-report.md\`: Markdown report for a verified low-risk session.
- \`sample-quality-gate.json\`: Machine-readable passing quality gate result.
- \`risky-quality-gate-comment.md\`: GitHub-ready failing quality gate body for a risky session.
- \`forensic-transcript-report.md\`: Lower-fidelity forensic transcript report with evidence-quality labels.
`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
