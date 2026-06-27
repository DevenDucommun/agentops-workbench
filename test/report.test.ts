import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { parseJsonlTranscript } from "../src/parser";
import { generateMarkdownReport } from "../src/report";
import { ingestTranscript, openStore } from "../src/store";

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
