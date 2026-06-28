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

test("detects and parses native Claude Code stream JSONL streams", () => {
  const input = loadAdapterInput("fixtures/claude-code-stream-session.jsonl");
  const adapter = resolveAdapter(input);
  const transcript = adapter.parse(input, defaultConfig);

  expect(adapter.id).toBe("claude-code-stream-json");
  expect(transcript.session.id).toBe("claude-stream-sample");
  expect(transcript.session.source).toBe("claude-code");
  expect(transcript.session.sourceAdapter).toBe("claude-code-stream-json");
  expect(transcript.session.model).toBe("claude-sonnet-4-5");
  expect(transcript.events.some((event) => event.type === "tool_call" && event.command === "bun test")).toBe(true);
  expect(transcript.events.some((event) => event.type === "file_edit" && event.path === "src/adapters.ts")).toBe(true);
  expect(transcript.events.some((event) => event.type === "tool_call" && event.toolName === "mcp__repo__read_file")).toBe(true);
  expect(transcript.events.some((event) => event.type === "tool_call" && event.toolName === "WebSearch")).toBe(true);
  expect(transcript.events.at(-1)?.type).toBe("final_response");
});

test("parses native Claude Code stream edge and partial fixtures", () => {
  const edgeInput = loadAdapterInput("fixtures/claude-code-stream-edge-session.jsonl");
  const edgeAdapter = resolveAdapter(edgeInput);
  const edgeTranscript = edgeAdapter.parse(edgeInput, defaultConfig);

  expect(edgeTranscript.session.id).toBe("claude-edge-sample");
  expect(edgeTranscript.events.some((event) => event.type === "tool_result" && event.status === "failed")).toBe(true);
  expect(edgeTranscript.events.some((event) => event.type === "tool_call" && event.command === "bun test")).toBe(true);
  expect(edgeTranscript.events.at(-1)?.type).toBe("final_response");

  const partialInput = loadAdapterInput("fixtures/claude-code-stream-partial-session.jsonl");
  const partialAdapter = resolveAdapter(partialInput);
  const partialTranscript = partialAdapter.parse(partialInput, defaultConfig);

  expect(partialTranscript.session.id).toBe("claude-partial-sample");
  expect(partialTranscript.events.some((event) => event.type === "tool_call" && event.command === "bun test")).toBe(true);
});

test("reports unsupported Claude Code stream JSONL shapes", () => {
  const input = {
    sourcePath: "claude-unsupported.jsonl",
    content: JSON.stringify({ type: "assistant" })
  };
  const adapter = resolveAdapter(input, "claude-code-stream-json");

  expect(() => adapter.parse(input, defaultConfig)).toThrow("assistant event must include a message object");
});

test("detects sanitized Codex export JSONL artifacts", () => {
  const input = loadAdapterInput("fixtures/codex-session.jsonl");
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("codex-jsonl");
});

test("reports unsupported Codex exec JSONL shapes", () => {
  const input = {
    sourcePath: "codex-unsupported.jsonl",
    content: [JSON.stringify({ type: "thread.started", thread_id: "synthetic-thread" }), JSON.stringify({ type: "item.completed" })].join("\n")
  };
  const adapter = resolveAdapter(input, "codex-exec-jsonl");

  expect(() => adapter.parse(input, defaultConfig)).toThrow("item.completed must include an item object");
});

test("detects and parses native Codex exec JSONL streams", () => {
  const input = loadAdapterInput("fixtures/codex-exec-session.jsonl");
  const adapter = resolveAdapter(input);
  const transcript = adapter.parse(input, defaultConfig);

  expect(adapter.id).toBe("codex-exec-jsonl");
  expect(transcript.session.id).toBe("codex-exec-sample");
  expect(transcript.session.source).toBe("codex");
  expect(transcript.session.sourceAdapter).toBe("codex-exec-jsonl");
  expect(transcript.events.some((event) => event.type === "tool_call" && event.command === "bun run typecheck")).toBe(true);
  expect(transcript.events.some((event) => event.type === "file_edit" && event.path === "src/adapters.ts")).toBe(true);
  expect(transcript.events.some((event) => event.type === "tool_call" && event.toolName === "mcp__repo__read_file")).toBe(true);
  expect(transcript.events.some((event) => event.type === "tool_call" && event.toolName === "web_search")).toBe(true);
  expect(transcript.events.at(-1)?.type).toBe("final_response");
});

test("parses native Codex exec edge and partial fixtures", () => {
  const edgeInput = loadAdapterInput("fixtures/codex-exec-edge-session.jsonl");
  const edgeAdapter = resolveAdapter(edgeInput);
  const edgeTranscript = edgeAdapter.parse(edgeInput, defaultConfig);

  expect(edgeTranscript.session.id).toBe("codex-edge-sample");
  expect(edgeTranscript.events.some((event) => event.type === "tool_call" && event.status === "failed" && event.command === "cat ./protected.txt")).toBe(true);
  expect(edgeTranscript.events.some((event) => event.type === "tool_call" && event.command === "bun test")).toBe(true);
  expect(edgeTranscript.events.at(-1)?.type).toBe("usage");
  expect(edgeTranscript.events.some((event) => event.type === "final_response")).toBe(true);

  const partialInput = loadAdapterInput("fixtures/codex-exec-partial-session.jsonl");
  const partialAdapter = resolveAdapter(partialInput);
  const partialTranscript = partialAdapter.parse(partialInput, defaultConfig);

  expect(partialTranscript.session.id).toBe("codex-partial-sample");
  expect(partialTranscript.events.some((event) => event.type === "tool_call" && event.status === "in_progress")).toBe(true);
});
