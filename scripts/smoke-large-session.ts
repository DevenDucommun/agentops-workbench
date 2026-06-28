import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { parseJsonlTranscript } from "../src/parser";
import { generateMarkdownReport } from "../src/report";
import { ingestTranscript, openStore } from "../src/store";

const eventCount = 2_500;
const maxDurationMs = 15_000;
const dir = mkdtempSync(join(tmpdir(), "agentops-large-session-smoke-"));
const fixturePath = join(dir, "large-session.jsonl");
const dbPath = join(dir, "agentops.db");
const started = performance.now();

writeFileSync(fixturePath, syntheticSession(eventCount));

const store = openStore(dbPath);
try {
  const transcript = parseJsonlTranscript(fixturePath, readFileSync(fixturePath, "utf8"));
  const result = ingestTranscript(store, transcript, defaultConfig);
  analyzeSession(store, result.sessionId, defaultConfig);
  const report = generateMarkdownReport(store, result.sessionId, defaultConfig);
  const durationMs = Math.round(performance.now() - started);

  if (result.eventCount !== eventCount) {
    fail(`Expected ${eventCount} events, ingested ${result.eventCount}.`);
  }
  if (!report.includes("# AgentOps Session Report")) {
    fail("Large session report did not render.");
  }
  if (durationMs > maxDurationMs) {
    fail(`Large session smoke exceeded ${maxDurationMs}ms: ${durationMs}ms.`);
  }

  console.log(`Large session smoke passed: ${eventCount} events in ${durationMs}ms.`);
} finally {
  store.db.close();
}

function syntheticSession(count: number): string {
  const lines = [
    JSON.stringify({
      schemaVersion: "agentops.event.v1",
      type: "session",
      id: "large-session-smoke",
      agent: "synthetic-agent",
      repo: "agentops-workbench",
      task: "Synthetic large session smoke"
    })
  ];

  for (let index = 0; index < count; index += 1) {
    if (index % 10 === 0) {
      lines.push(
        JSON.stringify({
          schemaVersion: "agentops.event.v1",
          type: "tool_call",
          toolName: "shell",
          input: { cmd: "bun test" },
          status: "completed",
          exitCode: 0,
          output: "pass"
        })
      );
      continue;
    }
    if (index % 5 === 0) {
      lines.push(
        JSON.stringify({
          schemaVersion: "agentops.event.v1",
          type: "file_edit",
          path: `src/generated-${index}.ts`,
          operation: "edit",
          linesAdded: 2,
          linesRemoved: 1
        })
      );
      continue;
    }
    lines.push(
      JSON.stringify({
        schemaVersion: "agentops.event.v1",
        type: "message",
        role: index % 2 === 0 ? "assistant" : "user",
        content: `Synthetic large-session event ${index}.`
      })
    );
  }

  return `${lines.join("\n")}\n`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
