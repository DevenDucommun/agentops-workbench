import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { parseJsonlTranscript } from "../src/parser";
import { ingestTranscript, openStore } from "../src/store";

test("migrates an older SQLite schema before ingest", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-migration-test-"));
  const dbPath = join(dir, "agentops.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      repo TEXT,
      task TEXT,
      started_at TEXT,
      ended_at TEXT,
      ingested_at TEXT NOT NULL
    );

    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      type TEXT NOT NULL,
      role TEXT,
      summary TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
  `);
  db.close();

  const store = openStore(dbPath);
  const sessionColumns = columnNames(store, "sessions");
  const eventColumns = columnNames(store, "events");

  expect(sessionColumns).toContain("schema_version");
  expect(sessionColumns).toContain("source_adapter");
  expect(sessionColumns).toContain("input_tokens");
  expect(sessionColumns).toContain("cost_currency");
  expect(eventColumns).toContain("raw_payload_hash");

  const transcript = parseJsonlTranscript(
    "migration.jsonl",
    [
      JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "migration-session" }),
      JSON.stringify({ schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 })
    ].join("\n")
  );
  const result = ingestTranscript(store, transcript);

  expect(result.sessionId).toBe("migration-session");
  expect(result.eventCount).toBe(1);
  store.db.close();
});

function columnNames(store: ReturnType<typeof openStore>, table: string): string[] {
  return (store.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}
