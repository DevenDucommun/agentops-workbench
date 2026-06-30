import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type CommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

type PackResult = {
  filename: string;
};

const repoRoot = resolve(import.meta.dir, "..");
const workDir = mkdtempSync(join(tmpdir(), "agentops-pack-install-smoke-"));
const npmCacheDir = join(workDir, "npm-cache");
const dbPath = join(workDir, "agentops.db");
const packResult = run(["npm", "pack", "--json", "--pack-destination", workDir], repoRoot);
if (packResult.status !== 0) fail(`npm pack failed:\n${packResult.stderr || packResult.stdout}`);

const pack = parsePackOutput(packResult.stdout);
const archivePath = join(workDir, pack.filename);
const extractDir = join(workDir, "extract");
runAndExpect(["mkdir", "-p", extractDir], "", workDir, true);
runAndExpect(["tar", "-xzf", archivePath, "-C", extractDir], "", workDir, true);

const packageDir = join(extractDir, "package");
if (!existsSync(packageDir)) fail(`Expected package directory at ${packageDir}`);

runAndExpect(["bun", "./bin/agentops", "--help"], "AgentOps Workbench", packageDir);
runAndExpect(["bun", "./bin/agentops", "init"], "AgentOps Init", packageDir);
runAndExpect(["bun", "./bin/agentops", "doctor"], "AgentOps Doctor", packageDir);
runAndExpect(["bun", "./bin/agentops", "doctor", "--fix"], "Safe fixes", packageDir);
runAndExpect(["bun", "./bin/agentops", "config", "--check"], "AgentOps config OK", packageDir);
runAndExpect(["bun", "./bin/agentops", "demo"], "sample-session", packageDir);
runAndExpect(["bun", "./bin/agentops", "ingest", "./fixtures/sample-session.jsonl"], "Ingested session sample-session", packageDir);
runAndExpect(["bun", "./bin/agentops", "audit", "./fixtures/sample-session.jsonl"], "AgentOps Audit", packageDir);
runAndExpect(["bun", "./bin/agentops", "import", "./fixtures/forensic-terminal-transcript.txt"], "Evidence quality: forensic text", packageDir);
runAndExpect(["bun", "./bin/agentops", "report", "--session", "latest"], "AgentOps Session Report", packageDir);
runAndExpect(["bun", "./bin/agentops", "gate", "sample-session"], "Status: PASSED", packageDir);
runAndExpect(["bun", "./bin/agentops", "export", "--session", "latest", "--format", "json"], "agentops.export.v1", packageDir);
runAndExpect(["bun", "./bin/agentops", "export", "--session", "latest", "--format", "openinference-json"], "agentops.openinference.v1", packageDir);

if (!existsSync(dbPath)) fail(`Expected package smoke database to exist at ${dbPath}`);

console.log("Packed tarball install smoke passed.");

function runAndExpect(command: string[], expected: string, cwd: string, allowNoExpectedText = false): CommandResult {
  const result = run(command, cwd);
  if (result.status !== 0) fail(`Command failed: ${command.join(" ")}\n${result.stderr || result.stdout}`);
  const output = `${result.stdout}\n${result.stderr}`;
  if (!allowNoExpectedText && !output.includes(expected)) {
    fail(`Command did not contain expected text: ${command.join(" ")}\nExpected: ${expected}\nOutput:\n${output}`);
  }
  return result;
}

function run(command: string[], cwd: string): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: {
      ...process.env,
      npm_config_cache: npmCacheDir,
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

function parsePackOutput(stdout: string): PackResult {
  const jsonStart = stdout.indexOf("[");
  if (jsonStart === -1) fail(`npm pack did not return JSON output:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== "object") {
    fail(`Unexpected npm pack JSON output:\n${stdout}`);
  }
  const pack = parsed[0] as Partial<PackResult>;
  if (typeof pack.filename !== "string") fail(`npm pack JSON output did not include filename:\n${stdout}`);
  return { filename: pack.filename };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
