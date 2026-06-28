import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type CommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

const repoRoot = resolve(import.meta.dir, "..");
const binDir = join(repoRoot, "bin");
const dbPath = join(mkdtempSync(join(tmpdir(), "agentops-install-smoke-")), "agentops.db");
const env = {
  ...process.env,
  PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  AGENTOPS_DB: dbPath
};

runAndExpect(["agentops", "--help"], "AgentOps Workbench");
runAndExpect(["agentops", "config", "--check"], "AgentOps config OK");
runAndExpect(["agentops", "adapters"], "agentops-jsonl");
runAndExpect(["agentops", "adapters", "--input", "fixtures/codex-session.jsonl"], "Codex Export JSONL");
runAndExpect(["agentops", "adapters", "--input", "fixtures/claude-code-stream-session.jsonl"], "Claude Code Stream JSON");
runAndExpect(["agentops", "adapters", "--input", "fixtures/codex-exec-session.jsonl"], "Codex Exec JSONL");
runAndExpect(["agentops", "adapters", "--input", "fixtures/claude-code-stream-edge-session.jsonl"], "Claude Code Stream JSON");
runAndExpect(["agentops", "adapters", "--input", "fixtures/codex-exec-edge-session.jsonl"], "Codex Exec JSONL");
runAndExpect(["agentops", "ingest", "fixtures/sample-session.jsonl"], "Ingested session sample-session");
runAndExpect(["agentops", "ingest", "fixtures/claude-code-stream-session.jsonl"], "Ingested session claude-stream-sample");
runAndExpect(["agentops", "ingest", "fixtures/codex-exec-session.jsonl"], "Ingested session codex-exec-sample");
runAndExpect(["agentops", "ingest", "fixtures/claude-code-stream-edge-session.jsonl"], "Ingested session claude-edge-sample");
runAndExpect(["agentops", "ingest", "fixtures/codex-exec-edge-session.jsonl"], "Ingested session codex-edge-sample");
runAndExpect(["agentops", "ingest", "fixtures/usage-session.jsonl"], "Ingested session usage-session");
runAndExpect(["agentops", "sessions"], "usage-session");
runAndExpect(["agentops", "inspect", "--session", "latest"], "Total Tokens");
runAndExpect(["agentops", "report", "--session", "latest"], "## Usage");
runAndExpect(["agentops", "dashboard", "--check"], "Dashboard configuration OK");
runAndExpect(["agentops", "scan-publication"], "Public-readiness scan passed.");

if (!existsSync(dbPath)) {
  fail(`Expected smoke database to exist at ${dbPath}`);
}

console.log("Install smoke test passed.");

function runAndExpect(command: string[], expected: string): CommandResult {
  const result = run(command);
  if (result.status !== 0) {
    fail(`Command failed: ${command.join(" ")}\n${result.stderr || result.stdout}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expected)) {
    fail(`Command did not contain expected text: ${command.join(" ")}\nExpected: ${expected}\nOutput:\n${output}`);
  }
  return result;
}

function run(command: string[]): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env,
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
