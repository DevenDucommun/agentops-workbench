import { mkdtempSync, writeFileSync } from "node:fs";
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

test("prints capture dry-run commands without invoking providers", async () => {
  const codex = await runCli([
    "capture",
    "codex",
    "review current diff",
    "--output",
    ".agentops/captures/codex.jsonl",
    "--ephemeral",
    "--dry-run"
  ]);
  expect(codex.exitCode).toBe(0);
  expect(codex.stdout).toContain("Capture command (dry run)");
  expect(codex.stdout).toContain("codex exec --json --ephemeral 'review current diff'");
  expect(codex.stdout).toContain("Adapter: codex-exec-jsonl");

  const claude = await runCli([
    "capture",
    "claude",
    "review current diff",
    "--output",
    ".agentops/captures/claude.jsonl",
    "--include-hook-events",
    "--dry-run"
  ]);
  expect(claude.exitCode).toBe(0);
  expect(claude.stdout).toContain("claude -p --output-format stream-json --verbose --include-hook-events 'review current diff'");
  expect(claude.stdout).toContain("Adapter: claude-code-stream-json");
});

test("validates config files", async () => {
  const defaults = await runCli(["config", "--check"]);
  expect(defaults.exitCode).toBe(0);
  expect(defaults.stdout).toContain("AgentOps config OK");
  expect(defaults.stdout).toContain("Using built-in defaults");

  const dir = mkdtempSync(join(tmpdir(), "agentops-config-test-"));
  const invalidPath = join(dir, "agentops.config.json");
  writeFileSync(
    invalidPath,
    JSON.stringify({
      schemaVersion: "agentops.config.v1",
      privacy: {
        storeRawPayload: true,
        redactBeforeStore: false,
        hashRawPayload: false
      },
      suppressions: [{ category: "large-churn" }]
    })
  );

  const invalid = await runCli(["config", "--check", "--config", invalidPath]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr).toContain("privacy.storeRawPayload requires privacy.redactBeforeStore");
  expect(invalid.stderr).toContain("privacy.storeRawPayload requires privacy.hashRawPayload");
  expect(invalid.stderr).toContain("suppressions[0].reason is required");
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

  const exported = await runCli(["export", "--session", "latest", "--format", "json"]);
  expect(exported.exitCode).toBe(0);
  const payload = JSON.parse(exported.stdout ?? "") as { schemaVersion: string; kind: string; events: Array<{ rawJson?: string }> };
  expect(payload.schemaVersion).toBe("agentops.export.v1");
  expect(payload.kind).toBe("session");
  expect(payload.events.every((event) => event.rawJson === undefined)).toBe(true);
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
