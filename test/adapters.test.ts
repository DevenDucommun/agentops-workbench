import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { detectAdapters, loadAdapterInput, resolveAdapter } from "../src/adapters";
import { defaultConfig } from "../src/config";

test("detects PAI export JSONL artifacts as canonical AgentOps JSONL", () => {
  const input = loadAdapterInput("fixtures/pai-export-session.jsonl");
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("agentops-jsonl");
});

test("parses PAI exports through the shared event schema, preserving source", () => {
  const input = {
    sourcePath: "fixtures/pai-export-session.jsonl",
    content: readFileSync("fixtures/pai-export-session.jsonl", "utf8")
  };
  const adapter = resolveAdapter(input, "agentops-jsonl");
  const transcript = adapter.parse(input, defaultConfig);

  expect(transcript.session.id).toBe("pai-export-sample");
  expect(transcript.session.source).toBe("pai");
  expect(transcript.session.sourceAdapter).toBe("agentops-jsonl");
  expect(transcript.events).toHaveLength(4);
});

test("detects sanitized Claude Code export JSONL as canonical AgentOps JSONL", () => {
  const input = loadAdapterInput("fixtures/claude-code-session.jsonl");
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("agentops-jsonl");
  expect(adapter.parse(input, defaultConfig).session.source).toBe("claude-code");
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

test("detects Claude Code streams that begin with hook system events", () => {
  const input = {
    sourcePath: "claude-hook-started.jsonl",
    content: [
      JSON.stringify({ type: "system", subtype: "hook_started", session_id: "claude-hook-sample" }),
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-hook-sample" }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "claude-hook-sample", result: "Done" })
    ].join("\n")
  };
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("claude-code-stream-json");
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

test("detects sanitized Codex export JSONL as canonical AgentOps JSONL", () => {
  const input = loadAdapterInput("fixtures/codex-session.jsonl");
  const adapter = resolveAdapter(input);

  expect(adapter.id).toBe("agentops-jsonl");
  expect(adapter.parse(input, defaultConfig).session.source).toBe("codex");
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

test("detects and parses forensic plain-text terminal transcripts", () => {
  const input = loadAdapterInput("fixtures/forensic-terminal-transcript.txt");
  const detection = detectAdapters(input).find((result) => result.adapter.id === "forensic-text")?.detection;
  const adapter = resolveAdapter(input);
  const transcript = adapter.parse(input, defaultConfig);

  expect(adapter.id).toBe("forensic-text");
  expect(detection?.reason).toContain("2 observed commands");
  expect(detection?.reason).toContain("file mention");
  expect(transcript.session.id).toBe("forensic-terminal-transcript");
  expect(transcript.session.source).toBe("forensic-text");
  expect(transcript.session.sourceAdapter).toBe("forensic-text");
  expect(transcript.events.some((event) => event.type === "tool_call" && event.command === 'rg -n "health|routes" src test')).toBe(true);
  expect(transcript.events.some((event) => event.type === "tool_call" && event.command === "bun test" && event.status === "observed")).toBe(true);
  expect(transcript.events.some((event) => event.type === "file_edit" && event.path === "src/server.ts")).toBe(true);
  expect(transcript.events.at(-1)?.type).toBe("final_response");
});

test("accepts final-only forensic text as a low-confidence audit", () => {
  const input = loadAdapterInput("fixtures/forensic-final-only.txt");
  const detection = detectAdapters(input).find((result) => result.adapter.id === "forensic-text")?.detection;
  const adapter = resolveAdapter(input);
  const transcript = adapter.parse(input, defaultConfig);

  expect(adapter.id).toBe("forensic-text");
  expect(detection?.reason).toContain("provider marker");
  expect(transcript.events.some((event) => event.type === "audit_note" && event.status === "missing")).toBe(true);
  expect(transcript.events.some((event) => event.type === "final_response" && event.confidence === "very-low")).toBe(true);
});

test("covers Codex final-output-only and Claude text forensic fixtures", () => {
  const codexInput = loadAdapterInput("fixtures/forensic-codex-final-output.txt");
  const codexAdapter = resolveAdapter(codexInput);
  const codexTranscript = codexAdapter.parse(codexInput, defaultConfig);

  expect(codexAdapter.id).toBe("forensic-text");
  expect(codexTranscript.session.agent).toBe("Codex");
  expect(codexTranscript.events.some((event) => event.type === "audit_note" && event.status === "missing")).toBe(true);
  expect(codexTranscript.events.some((event) => event.type === "final_response" && event.confidence === "very-low")).toBe(true);

  const claudeInput = loadAdapterInput("fixtures/forensic-claude-text-output.txt");
  const claudeAdapter = resolveAdapter(claudeInput);
  const claudeTranscript = claudeAdapter.parse(claudeInput, defaultConfig);

  expect(claudeAdapter.id).toBe("forensic-text");
  expect(claudeTranscript.session.agent).toBe("Claude Code");
  expect(claudeTranscript.events.some((event) => event.type === "tool_call" && event.command === "bun test" && event.status === "inferred")).toBe(true);
  expect(claudeTranscript.events.some((event) => event.type === "file_edit" && event.path === "src/dashboard.ts")).toBe(true);
});

test("does not auto-detect unsupported non-transcript text without markers", () => {
  const input = {
    sourcePath: "notes.bin",
    content: "This is just a generic note with no agent, command, or file evidence."
  };

  expect(() => resolveAdapter(input)).toThrow("Could not detect an adapter");
});

test("parses current Codex exec schema (0.16x): aggregated_output, changes[], server/tool MCP, todo_list, collab, error items", () => {
  const input = loadAdapterInput("fixtures/codex-exec-current-session.jsonl");
  const adapter = resolveAdapter(input);
  const transcript = adapter.parse(input, defaultConfig);
  const events = transcript.events;

  expect(adapter.id).toBe("codex-exec-jsonl");
  expect(transcript.session.id).toBe("codex-exec-current-sample");

  const typecheck = events.find((event) => event.command === "bun run typecheck" && event.status === "completed");
  expect(typecheck?.output).toBe("typecheck passed\n");
  expect(typecheck?.exitCode).toBe(0);

  const edits = events.filter((event) => event.type === "file_edit");
  expect(edits.map((event) => [event.path, event.operation])).toEqual([
    ["src/adapters.ts", "edit"],
    ["src/adapterNotes.ts", "create"]
  ]);

  expect(events.some((event) => event.type === "tool_call" && event.toolName === "mcp__repo__read_file")).toBe(true);
  expect(events.some((event) => event.command === "rm -rf ./build" && event.status === "declined")).toBe(true);
  expect(events.some((event) => event.toolName === "collab:spawn_agent" && event.summary === "Codex subagent spawn_agent (1 agent).")).toBe(true);
  expect(events.some((event) => event.type === "error" && String(event.summary).includes("MCP server was unavailable"))).toBe(true);

  const plans = events.filter((event) => event.type === "plan" && String(event.summary).startsWith("Codex plan:"));
  expect(plans.map((event) => event.summary)).toEqual(["Codex plan: 0/3 steps done.", "Codex plan: 3/3 steps done."]);
  expect(events.some((event) => String(event.summary).includes("item.updated"))).toBe(false);
  expect(events.some((event) => event.type === "final_response")).toBe(true);
});

test("parses current Claude Code stream schema (2.1): hooks, init model, permission denials", () => {
  const input = loadAdapterInput("fixtures/claude-code-stream-current-session.jsonl");
  const adapter = resolveAdapter(input);
  const transcript = adapter.parse(input, defaultConfig);
  const events = transcript.events;

  expect(adapter.id).toBe("claude-code-stream-json");
  expect(adapter.detect(input).confidence).toBe(1);
  expect(transcript.session.id).toBe("claude-stream-current-sample");
  expect(transcript.session.model).toBe("claude-sonnet-5-5");

  const hooks = events.filter((event) => String(event.summary).startsWith("Claude Code hook"));
  expect(hooks.map((event) => event.summary)).toEqual([
    "Claude Code hook SessionStart:startup: success (exit 0)",
    "Claude Code hook SessionStart:startup: error (exit 1)"
  ]);
  expect(JSON.stringify(events)).not.toContain("synthetic hook failure");

  expect(events.some((event) => event.type === "file_edit" && event.path === "src/adapters.ts")).toBe(true);
  expect(events.some((event) => event.type === "tool_call" && event.command === "bun test")).toBe(true);
  expect(events.some((event) => event.type === "final_response")).toBe(true);

  // The denied tool_use is recorded once, marked denied — not as a completed call plus a denial copy.
  const push = events.filter((event) => event.command === "git push origin main");
  expect(push).toHaveLength(1);
  expect(push[0]?.status).toBe("denied");
  expect(push[0]?.summary).toBe("Permission denied: Bash (git push origin main)");
});

test("records a denied Claude tool use once and never as an executed command or file change", () => {
  const sid = "claude-denied-sample";
  const lines = [
    { type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-5-5" },
    {
      type: "assistant",
      session_id: sid,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t-rm", name: "Bash", input: { command: "rm -rf ./build" } },
          { type: "tool_use", id: "t-test", name: "Bash", input: { command: "bun test" } },
          { type: "tool_use", id: "t-edit", name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } }
        ]
      }
    },
    {
      type: "result",
      subtype: "success",
      session_id: sid,
      is_error: false,
      result: "Done; tests pass.",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "t-rm", tool_input: { command: "rm -rf ./build" } },
        { tool_name: "Bash", tool_use_id: "t-test", tool_input: { command: "bun test" } },
        { tool_name: "Edit", tool_use_id: "t-edit", tool_input: { file_path: "src/a.ts" } },
        { tool_name: "Bash", tool_use_id: "t-missing", tool_input: { command: "git push" } }
      ]
    }
  ];
  const input = { sourcePath: "claude-denied.jsonl", content: lines.map((line) => JSON.stringify(line)).join("\n") };
  const events = resolveAdapter(input, "claude-code-stream-json").parse(input, defaultConfig).events;

  expect(events.filter((event) => event.command === "rm -rf ./build").map((event) => event.status)).toEqual(["denied"]);
  expect(events.filter((event) => event.command === "bun test").map((event) => event.status)).toEqual(["denied"]);
  expect(events.some((event) => event.type === "file_edit")).toBe(false);
  expect(events.filter((event) => event.command === "git push").map((event) => event.status)).toEqual(["denied"]);
});

test("reports Claude Code API errors and terminal_reason instead of a generic failure", () => {
  const input = loadAdapterInput("fixtures/claude-code-stream-api-error-session.jsonl");
  const transcript = resolveAdapter(input).parse(input, defaultConfig);
  const errors = transcript.events.filter((event) => event.type === "error");

  expect(transcript.session.model).toBe("claude-sonnet-5-5");
  expect(errors.map((event) => [event.status, event.summary])).toEqual([
    ["authentication_failed", "Claude Code API error (authentication_failed): Not logged in · Please run /login"],
    ["api_error", "Claude Code execution failed (api_error): Not logged in · Please run /login"]
  ]);
  expect(transcript.events.some((event) => event.type === "final_response")).toBe(false);
});
