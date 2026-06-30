import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type PackFile = {
  path: string;
};

type PackResult = {
  files: PackFile[];
};

const repoRoot = resolve(import.meta.dir, "..");
const cacheDir = mkdtempSync(join(tmpdir(), "agentops-npm-cache-"));
const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    npm_config_cache: cacheDir
  },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

if (result.status !== 0) {
  fail(`npm pack dry run failed:\n${result.stderr || result.stdout}`);
}

const pack = parsePackOutput(result.stdout);
const files = new Set(pack.files.map((file) => file.path));

for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "bin/agentops",
  "scripts/generate-demo-artifacts.ts",
  "src/cli.ts",
  "src/adapters.ts",
  "src/capture.ts",
  "src/claudeStream.ts",
  "src/codexExec.ts",
  "src/gate.ts",
  "templates/hooks/write-hook-envelope.mjs",
  "templates/hooks/codex/hooks.json",
  "templates/hooks/claude/settings.json",
  "fixtures/sample-session.jsonl",
  "fixtures/claude-code-stream-session.jsonl",
  "fixtures/hook-envelope-session.jsonl",
  "fixtures/forensic-terminal-transcript.txt",
  "fixtures/forensic-codex-final-output.txt",
  "fixtures/forensic-claude-text-output.txt",
  "docs/INSTALLATION.md",
  "docs/CLI.md",
  "docs/COMPATIBILITY.md",
  "docs/QUALITY_GATES.md",
  "docs/demo/README.md",
  "docs/demo/sample-session-report.md",
  "docs/demo/sample-quality-gate.json",
  "docs/demo/risky-quality-gate-comment.md",
  "docs/demo/forensic-transcript-report.md",
  "docs/ROADMAP_POST_1_0.md"
]) {
  if (!files.has(required)) fail(`Package dry run is missing required file: ${required}`);
}

for (const excluded of [
  ".github/workflows/ci.yml",
  ".specify/memory/constitution.md",
  "specs/001-agentops-workbench/spec.md",
  "test/cli.test.ts",
  "report.md",
  "docs/assets/dashboard-v1.2.0.png"
]) {
  if (files.has(excluded)) fail(`Package dry run includes excluded file: ${excluded}`);
}

console.log(`Package smoke passed with ${files.size} files.`);

function parsePackOutput(stdout: string): PackResult {
  const jsonStart = stdout.indexOf("[");
  if (jsonStart === -1) fail(`npm pack did not return JSON output:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object") {
    fail(`Unexpected npm pack JSON output:\n${stdout}`);
  }
  const pack = parsed[0] as Partial<PackResult>;
  if (!Array.isArray(pack.files)) fail(`npm pack JSON output did not include files:\n${stdout}`);
  return { files: pack.files };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
