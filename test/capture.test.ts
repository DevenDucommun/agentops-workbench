import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseCaptureArgs, runCapture, type CaptureExecutor } from "../src/capture";

test("builds Codex capture commands with supported options", () => {
  const request = parseCaptureArgs(
    ["codex", "review current diff", "--output", ".agentops/captures/codex.jsonl", "--ephemeral", "--sandbox", "workspace-write"],
    new Date("2026-06-29T00:00:00.000Z")
  );

  expect(request.provider).toBe("codex");
  expect(request.outputPath).toBe(".agentops/captures/codex.jsonl");
  expect(request.adapterId).toBe("codex-exec-jsonl");
  expect(request.command).toEqual(["codex", "exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "review current diff"]);
});

test("builds Claude capture commands with supported options", () => {
  const request = parseCaptureArgs(
    ["claude", "review current diff", "--include-hook-events", "--no-session-persistence", "--permission-mode", "default"],
    new Date("2026-06-29T00:00:00.000Z")
  );

  expect(request.provider).toBe("claude");
  expect(request.outputPath).toBe(".agentops/captures/claude-2026-06-29T00-00-00-000Z.jsonl");
  expect(request.adapterId).toBe("claude-code-stream-json");
  expect(request.command).toEqual([
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--no-session-persistence",
    "--permission-mode",
    "default",
    "review current diff"
  ]);
});

test("writes successful capture stdout to the requested artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentops-capture-test-"));
  const outputPath = join(dir, "codex.jsonl");
  const request = parseCaptureArgs(["codex", "summarize", "--output", outputPath]);
  const executor: CaptureExecutor = async () => ({
    exitCode: 0,
    stdout: '{"type":"thread.started","thread_id":"synthetic"}\n',
    stderr: "provider progress\n"
  });

  const result = await runCapture(request, executor);

  expect(result.outputPath).toBe(outputPath);
  expect(result.stderr).toBe("provider progress\n");
  expect(readFileSync(outputPath, "utf8")).toBe('{"type":"thread.started","thread_id":"synthetic"}\n');
});

test("preserves partial artifacts from failed capture commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentops-capture-failed-test-"));
  const outputPath = join(dir, "codex.jsonl");
  const request = parseCaptureArgs(["codex", "summarize", "--output", outputPath]);
  const executor: CaptureExecutor = async () => ({
    exitCode: 1,
    stdout: '{"type":"turn.failed","error":"synthetic failure"}\n',
    stderr: "failed provider run\n"
  });

  await expect(runCapture(request, executor)).rejects.toThrow("Partial artifact");
  expect(readFileSync(outputPath, "utf8")).toBe('{"type":"turn.failed","error":"synthetic failure"}\n');
});

test("rejects empty capture artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentops-capture-empty-test-"));
  const outputPath = join(dir, "claude.jsonl");
  mkdirSync(dir, { recursive: true });
  const request = parseCaptureArgs(["claude", "summarize", "--output", outputPath]);
  const executor: CaptureExecutor = async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "no output\n"
  });

  await expect(runCapture(request, executor)).rejects.toThrow("empty artifact");
  expect(existsSync(outputPath)).toBe(false);
});

test("hook template helper writes bounded hook envelopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentops-hook-template-test-"));
  const result = spawnSync("bun", ["templates/hooks/write-hook-envelope.mjs", "--source", "claude-code"], {
    cwd: process.cwd(),
    input: JSON.stringify({
      session_id: "synthetic-session",
      transcript_path: "workspace/.claude/projects/private/transcript.jsonl",
      cwd: "workspace/private-repo",
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "bun test"
      }
    }),
    env: {
      ...process.env,
      AGENTOPS_HOOK_CAPTURE_PATH: join(dir, "hook-events.jsonl")
    },
    encoding: "utf8"
  });

  expect(result.status).toBe(0);
  const content = readFileSync(join(dir, "hook-events.jsonl"), "utf8");
  const envelope = JSON.parse(content) as {
    schemaVersion: string;
    sessionId: string;
    event: { type: string; toolName?: string; input: Record<string, unknown> };
  };
  expect(envelope.schemaVersion).toBe("agentops.hook-envelope.v1");
  expect(envelope.sessionId).toBe("synthetic-session");
  expect(envelope.event.type).toBe("tool_call");
  expect(envelope.event.toolName).toBe("Bash");
  expect(JSON.stringify(envelope.event.input)).not.toContain("transcript");
  expect(JSON.stringify(envelope.event.input)).not.toContain("private-repo");
});
