import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { parseJsonlTranscript } from "../src/parser";
import { generateMarkdownReport } from "../src/report";
import { ingestTranscript, openStore } from "../src/store";

test("sample session report matches golden output", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-golden-report-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript("fixtures/sample-session.jsonl", readFileSync("fixtures/sample-session.jsonl", "utf8"));
  ingestTranscript(store, transcript, defaultConfig);
  analyzeSession(store, "sample-session", defaultConfig);

  const report = generateMarkdownReport(store, "sample-session", defaultConfig);
  const golden = readFileSync("fixtures/golden/sample-report.md", "utf8");
  expect(report).toBe(golden);

  store.db.close();
});
