import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runCli } from "../src/cli";

const originalDb = process.env.AGENTOPS_DB;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-cli-test-"));
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
});

afterEach(() => {
  if (originalDb === undefined) {
    delete process.env.AGENTOPS_DB;
  } else {
    process.env.AGENTOPS_DB = originalDb;
  }
});

test("lists adapters and detection diagnostics", async () => {
  const list = await runCli(["adapters"]);
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain("claude-code-jsonl");
  expect(list.stdout).toContain("claude-code-stream-json");
  expect(list.stdout).toContain("codex-jsonl");
  expect(list.stdout).toContain("pai-export-jsonl");

  const detected = await runCli(["adapters", "--input", "fixtures/codex-session.jsonl"]);
  expect(detected.exitCode).toBe(0);
  expect(detected.stdout).toContain("Codex Export JSONL (100%)");
  expect(detected.stdout).toContain("found Codex source metadata");
});

test("ingests then lists and inspects sessions", async () => {
  const ingest = await runCli(["ingest", "fixtures/claude-code-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);
  expect(ingest.stdout).toContain("Adapter: claude-code-jsonl");

  const sessions = await runCli(["sessions"]);
  expect(sessions.exitCode).toBe(0);
  expect(sessions.stdout).toContain("claude-code-sample");
  expect(sessions.stdout).toContain("claude-code-jsonl");

  const inspect = await runCli(["inspect", "--session", "latest"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("# AgentOps Session Inspection");
  expect(inspect.stdout).toContain("Claude Code");
  expect(inspect.stdout).toContain("Verification Commands");
  expect(inspect.stdout).toContain("Synthetic Claude Code export completed");
});

test("inspect and sessions include usage metadata when available", async () => {
  const ingest = await runCli(["ingest", "fixtures/usage-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);

  const sessions = await runCli(["sessions"]);
  expect(sessions.exitCode).toBe(0);
  expect(sessions.stdout).toContain("usage-session");
  expect(sessions.stdout).toContain("1,540");

  const inspect = await runCli(["inspect", "--session", "usage-session"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("Input Tokens");
  expect(inspect.stdout).toContain("Output Tokens");
  expect(inspect.stdout).toContain("Total Tokens");
  expect(inspect.stdout).toContain("0.0142 USD");
});

test("ingests native Codex exec JSONL without explicit adapter selection", async () => {
  const ingest = await runCli(["ingest", "fixtures/codex-exec-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);
  expect(ingest.stdout).toContain("Adapter: codex-exec-jsonl");

  const inspect = await runCli(["inspect", "--session", "codex-exec-sample"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("Codex");
  expect(inspect.stdout).toContain("bun run typecheck");
  expect(inspect.stdout).toContain("Total Tokens");
  expect(inspect.stdout).toContain("1,150");
});

test("ingests native Claude Code stream JSONL without explicit adapter selection", async () => {
  const ingest = await runCli(["ingest", "fixtures/claude-code-stream-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);
  expect(ingest.stdout).toContain("Adapter: claude-code-stream-json");

  const inspect = await runCli(["inspect", "--session", "claude-stream-sample"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("Claude Code");
  expect(inspect.stdout).toContain("bun test");
  expect(inspect.stdout).toContain("Total Tokens");
  expect(inspect.stdout).toContain("1,180");
  expect(inspect.stdout).toContain("0.0123 USD");
});
