import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { parseJsonlTranscript } from "../src/parser";
import { generateMarkdownReport } from "../src/report";
import { getCommands, getEvents, ingestTranscript, openStore } from "../src/store";

test("ingests a session and generates a markdown report", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const fixture = readFileSync("fixtures/sample-session.jsonl", "utf8");
  const transcript = parseJsonlTranscript("fixtures/sample-session.jsonl", fixture);
  const result = ingestTranscript(store, transcript);
  analyzeSession(store, result.sessionId);

  const report = generateMarkdownReport(store, "sample-session");
  expect(report).toContain("# AgentOps Session Report");
  expect(report).toContain("`bun test`");
  expect(report).toContain("No risk flags detected");
  expect(report).toContain("Implemented the /health endpoint");

  store.db.close();
});

test("flags unsupported success claims", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript(
    "unsupported.jsonl",
    [
      JSON.stringify({ type: "session", id: "unsupported" }),
      JSON.stringify({ type: "file_edit", path: ".env", operation: "edit", linesAdded: 1, linesRemoved: 0 }),
      JSON.stringify({ type: "final_response", content: "Completed successfully." })
    ].join("\n")
  );
  ingestTranscript(store, transcript);
  analyzeSession(store, "unsupported");

  const report = generateMarkdownReport(store, "unsupported");
  expect(report).toContain("sensitive-file");
  expect(report).toContain("unsupported-success-claim");

  store.db.close();
});

test("stores hashes but not raw payloads by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const syntheticEmail = `user${"@"}example.test`;
  const syntheticLocalPath = `/${"Users"}/example/project`;
  const transcript = parseJsonlTranscript(
    "privacy.jsonl",
    [
      JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "privacy" }),
      JSON.stringify({
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        input: { cmd: "echo hello" },
        output: `Contact ${syntheticEmail} from ${syntheticLocalPath}`
      })
    ].join("\n")
  );

  ingestTranscript(store, transcript, defaultConfig);

  const events = getEvents(store, "privacy");
  const commands = getCommands(store, "privacy");

  expect(events[0]?.rawJson).toBe("");
  expect(events[0]?.rawPayloadHash).toHaveLength(64);
  expect(commands[0]?.output).toContain("[REDACTED:email]");
  expect(commands[0]?.output).toContain("[REDACTED:local-path]");

  store.db.close();
});

test("can retain redacted raw payloads when configured", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const syntheticEmail = `user${"@"}example.test`;
  const config = {
    ...defaultConfig,
    privacy: {
      ...defaultConfig.privacy,
      storeRawPayload: true
    }
  };
  const transcript = parseJsonlTranscript(
    "raw.jsonl",
    [
      JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "raw" }),
      JSON.stringify({
        schemaVersion: "agentops.event.v1",
        type: "message",
        content: `Email ${syntheticEmail}`
      })
    ].join("\n"),
    { config }
  );

  ingestTranscript(store, transcript, config);

  const events = getEvents(store, "raw");
  expect(events[0]?.rawJson).toContain("[REDACTED:email]");
  expect(events[0]?.rawJson).not.toContain(syntheticEmail);

  store.db.close();
});
