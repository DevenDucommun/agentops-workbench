import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { loadAdapterInput, resolveAdapter } from "../src/adapters";
import { defaultConfig } from "../src/config";

test("detects PAI export JSONL artifacts", () => {
  const input = loadAdapterInput("fixtures/pai-export-session.jsonl");
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("pai-export-jsonl");
});

test("parses PAI exports through the shared event schema", () => {
  const input = {
    sourcePath: "fixtures/pai-export-session.jsonl",
    content: readFileSync("fixtures/pai-export-session.jsonl", "utf8")
  };
  const adapter = resolveAdapter(input, "pai-export-jsonl");
  const transcript = adapter.parse(input, defaultConfig);

  expect(transcript.session.id).toBe("pai-export-sample");
  expect(transcript.session.source).toBe("pai");
  expect(transcript.session.sourceAdapter).toBe("pai-export-jsonl");
  expect(transcript.events).toHaveLength(4);
});

test("detects sanitized Claude Code export JSONL artifacts", () => {
  const input = loadAdapterInput("fixtures/claude-code-session.jsonl");
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("claude-code-jsonl");
});

test("detects sanitized Codex export JSONL artifacts", () => {
  const input = loadAdapterInput("fixtures/codex-session.jsonl");
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("codex-jsonl");
});
