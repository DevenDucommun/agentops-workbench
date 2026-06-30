import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type CommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

const tag = process.argv[2];
if (!tag) {
  fail("Usage: bun ./scripts/smoke-release-archive.ts <tag>");
}

const owner = process.env.AGENTOPS_RELEASE_OWNER ?? "DevenDucommun";
const repo = process.env.AGENTOPS_RELEASE_REPO ?? "agentops-workbench";
const archiveUrl = `https://github.com/${owner}/${repo}/archive/refs/tags/${tag}.tar.gz`;
const workDir = mkdtempSync(join(tmpdir(), `agentops-${tag}-archive-smoke-`));
const archivePath = join(workDir, `${tag}.tar.gz`);
const extractDir = join(workDir, "src");
const checkoutDir = join(extractDir, `${repo}-${tag.replace(/^v/, "")}`);
const dbPath = join(workDir, "agentops.db");

await mkdir(extractDir, { recursive: true });
await download(archiveUrl, archivePath);
runAndExpect(["tar", "-xzf", archivePath, "-C", extractDir], "", { cwd: workDir });

if (!existsSync(checkoutDir)) {
  fail(`Expected extracted archive directory at ${checkoutDir}`);
}

runAndExpect(["bun", "install", "--frozen-lockfile"], "Saved lockfile", { cwd: checkoutDir, allowNoExpectedText: true });
runAndExpect(["./bin/agentops", "--help"], "AgentOps Workbench", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "doctor"], "AgentOps Doctor", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "demo"], "sample-session", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "adapters"], "codex-exec-jsonl", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "adapters", "--input", "./fixtures/claude-code-stream-session.jsonl"], "Claude Code Stream JSON", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "import", "./fixtures/sample-session.jsonl"], "Ingested session sample-session", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "audit", "./fixtures/sample-session.jsonl"], "AgentOps Audit", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "import", "./fixtures/claude-code-stream-session.jsonl"], "Ingested session claude-stream-sample", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "import", "./fixtures/codex-exec-session.jsonl"], "Ingested session codex-exec-sample", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "import", "./fixtures/forensic-terminal-transcript.txt"], "Evidence quality: forensic text", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "sessions"], "codex-exec-sample", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "gate", "sample-session"], "Status: PASSED", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "review", "latest", "--format", "markdown"], "AgentOps Session Report", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "dashboard", "--check"], "Dashboard configuration OK", { cwd: checkoutDir });
runAndExpect(["bun", "run", "smoke:demo-artifacts"], "Demo artifacts are up to date", { cwd: checkoutDir });
runAndExpect(["bun", "run", "smoke:package"], "Package smoke passed", { cwd: checkoutDir });
runAndExpect(["./bin/agentops", "scan-publication"], "Public-readiness scan passed", { cwd: checkoutDir });

if (!existsSync(dbPath)) {
  fail(`Expected archive smoke database to exist at ${dbPath}`);
}

console.log(`Release archive smoke passed for ${tag}`);
console.log(`Archive work dir: ${workDir}`);

async function download(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  await writeFile(outputPath, body);
}

function runAndExpect(
  command: string[],
  expected: string,
  options: { cwd: string; allowNoExpectedText?: boolean }
): CommandResult {
  const result = run(command, options.cwd);
  if (result.status !== 0) {
    fail(`Command failed: ${command.join(" ")}\n${result.stderr || result.stdout}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!options.allowNoExpectedText && !output.includes(expected)) {
    fail(`Command did not contain expected text: ${command.join(" ")}\nExpected: ${expected}\nOutput:\n${output}`);
  }
  return result;
}

function run(command: string[], cwd: string): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: {
      ...process.env,
      AGENTOPS_DB: dbPath
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status
  };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
