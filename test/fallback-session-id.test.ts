import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseForensicTextTranscript } from "../src/forensicText";
import { fallbackSessionId, parseJsonlTranscript } from "../src/parser";
import { ingestTranscript, listSessions, openStore } from "../src/store";

const runA = "$ bun test\n12 pass\nAll tests pass.\n";
const runB = "$ bun run lint\nNo problems.\nLint is clean.\n";

test("two different artifacts with the same file name keep separate sessions", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-fallback-")), "agentops.db"));
  ingestTranscript(store, parseForensicTextTranscript("run-a/terminal.txt", runA, defaultConfig), defaultConfig);
  ingestTranscript(store, parseForensicTextTranscript("run-b/terminal.txt", runB, defaultConfig), defaultConfig);
  const ids = listSessions(store).map((session) => session.id);
  expect(ids).toHaveLength(2);
  expect(ids.every((id) => id.startsWith("terminal-"))).toBe(true);

  // Re-importing the same artifact replaces its earlier import.
  ingestTranscript(store, parseForensicTextTranscript("run-a/terminal.txt", runA, defaultConfig), defaultConfig);
  expect(listSessions(store)).toHaveLength(2);
  store.db.close();
});

test("the fallback id depends on content, not on where the file sits", () => {
  expect(fallbackSessionId("a/terminal.txt", runA, "x")).toBe(fallbackSessionId("b/terminal.txt", runA, "x"));
  expect(fallbackSessionId("a/terminal.txt", runA, "x")).not.toBe(fallbackSessionId("a/terminal.txt", runB, "x"));
  expect(fallbackSessionId(".txt", runA, "x")).toMatch(/^x-[0-9a-f]{8}$/);
});

test("an id carried in the artifact still wins", () => {
  const input = `${JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "named" })}\n`;
  expect(parseJsonlTranscript("terminal.jsonl", input).session.id).toBe("named");
});
