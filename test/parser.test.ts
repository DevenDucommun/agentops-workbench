import { expect, test } from "bun:test";
import { extractCommand, parseJsonlTranscript } from "../src/parser";

test("parses a JSONL transcript with session metadata", () => {
  const parsed = parseJsonlTranscript(
    "fixture.jsonl",
    [
      JSON.stringify({ type: "session", id: "abc", agent: "KAI" }),
      JSON.stringify({ type: "tool_call", input: { cmd: "bun test" } })
    ].join("\n")
  );

  expect(parsed.session.id).toBe("abc");
  expect(parsed.session.agent).toBe("KAI");
  expect(parsed.events).toHaveLength(1);
  expect(extractCommand(parsed.events[0])).toBe("bun test");
});

test("reports malformed JSONL line numbers", () => {
  expect(() => parseJsonlTranscript("bad.jsonl", "{\"type\":\"message\"}\nnope")).toThrow("line 2");
});
