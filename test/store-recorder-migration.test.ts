import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { parseJsonlTranscript } from "../src/parser";
import { generateMarkdownReport } from "../src/report";
import {
  findSessionsForCommit,
  getEventChain,
  getEvents,
  getSessionCommits,
  ingestTranscript,
  linkSessionCommit,
  migrate,
  openStore
} from "../src/store";

// The v3.2.0 schema, as created by that release's migrate(). Kept literal so
// the test keeps describing a real v3.2 database after migrate() changes.
const V3_2_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source_path TEXT NOT NULL, schema_version TEXT, source_adapter TEXT,
    agent TEXT, model TEXT, repo TEXT, task TEXT, started_at TEXT, ended_at TEXT,
    input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cost_amount REAL,
    cost_currency TEXT, ingested_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, type TEXT NOT NULL, role TEXT, summary TEXT NOT NULL,
    raw_payload_hash TEXT, raw_json TEXT NOT NULL
  );
  CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    command TEXT NOT NULL, status TEXT, exit_code INTEGER, output TEXT
  );
  CREATE TABLE file_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    path TEXT NOT NULL, operation TEXT NOT NULL, lines_added INTEGER, lines_removed INTEGER
  );
  CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL, category TEXT NOT NULL, status TEXT
  );
  CREATE TABLE risk_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    severity TEXT NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL
  );
`;

const CHAIN_COLUMNS = ["event_uid", "seq", "prev_hash", "event_hash", "cwd", "git_head", "tool_use_id", "parent_tool_use_id", "agent_id", "content_hash"];

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function v32Database(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), "agentops-v32-migration-")), "agentops.db");
  const db = new Database(dbPath);
  db.exec(V3_2_SCHEMA);
  db.exec(`
    INSERT INTO sessions (id, source_path, schema_version, source_adapter, ingested_at)
      VALUES ('legacy', 'legacy.jsonl', 'agentops.event.v1', 'agentops-jsonl', '2026-11-01T00:00:00.000Z');
    INSERT INTO events (session_id, idx, type, role, summary, raw_payload_hash, raw_json)
      VALUES ('legacy', 1, 'command', NULL, 'bun test', 'abc', '');
    INSERT INTO commands (session_id, event_id, command, status, exit_code, output)
      VALUES ('legacy', 1, 'bun test', 'completed', 0, '1 pass');
  `);
  db.close();
  return dbPath;
}

test("migrates a v3.2 database: adds chain columns and session_commits, keeps existing rows", () => {
  const store = openStore(v32Database());

  expect(columnNames(store.db, "events")).toEqual(expect.arrayContaining(CHAIN_COLUMNS));
  expect(columnNames(store.db, "sessions")).toContain("chain_head_hash");
  expect(columnNames(store.db, "session_commits")).toEqual(["session_id", "sha", "branch", "kind", "source", "event_id"]);
  const indexes = (store.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
  expect(indexes).toEqual(expect.arrayContaining(["idx_session_commits_sha", "idx_events_content_hash"]));

  // Legacy rows survive, with NULL chain fields.
  expect(getEvents(store, "legacy").map((e) => e.summary)).toEqual(["bun test"]);
  expect(getEventChain(store, "legacy")).toEqual([
    { id: 1, idx: 1, eventUid: null, seq: null, prevHash: null, eventHash: null, cwd: null, gitHead: null, toolUseId: null, parentToolUseId: null, agentId: null, contentHash: null }
  ]);
  store.db.close();
});

test("migration is idempotent", () => {
  const store = openStore(v32Database());
  const before = store.db.query("SELECT sql FROM sqlite_master ORDER BY name").all();
  migrate(store.db);
  migrate(store.db);
  expect(store.db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  store.db.close();
});

test("a migrated v3.2 database still produces the golden report for a legacy import", () => {
  const store = openStore(v32Database());
  const transcript = parseJsonlTranscript("fixtures/sample-session.jsonl", readFileSync("fixtures/sample-session.jsonl", "utf8"));
  ingestTranscript(store, transcript, defaultConfig);
  analyzeSession(store, "sample-session", defaultConfig);
  expect(generateMarkdownReport(store, "sample-session", defaultConfig)).toBe(readFileSync("fixtures/golden/sample-report.md", "utf8"));
  store.db.close();
});

test("ingest stores well-typed chain fields and nulls the rest", () => {
  const store = openStore(v32Database());
  const lines = [
    { schemaVersion: "agentops.event.v1", type: "session", id: "chained" },
    {
      type: "file_edit", path: "math.js", operation: "edit",
      eventId: "chained:1", seq: 1, prevHash: null, hash: "a".repeat(64),
      cwd: "/workspace/demo-repo", gitHead: "a1b2c3d", toolUseId: "toolu_01Synthetic0001N01000000",
      agentId: "a0b1c2d3e4f5a6b7c", parentToolUseId: "toolu_01Synthetic0001N00000000", contentHash: "b".repeat(64)
    },
    { type: "message", content: "x", eventId: 42, seq: 2.5, hash: { not: "a string" }, cwd: ["/x"] }
  ];
  ingestTranscript(store, parseJsonlTranscript("chained.jsonl", lines.map((l) => JSON.stringify(l)).join("\n")));

  const [first, second] = getEventChain(store, "chained");
  expect(first).toMatchObject({
    eventUid: "chained:1", seq: 1, prevHash: null, eventHash: "a".repeat(64), cwd: "/workspace/demo-repo",
    gitHead: "a1b2c3d", toolUseId: "toolu_01Synthetic0001N01000000", agentId: "a0b1c2d3e4f5a6b7c",
    parentToolUseId: "toolu_01Synthetic0001N00000000", contentHash: "b".repeat(64)
  });
  expect(second).toMatchObject({ eventUid: null, seq: null, eventHash: null, cwd: null });
  store.db.close();
});

test("links commits to sessions and finds them by short or full SHA", () => {
  const store = openStore(v32Database());
  const full = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  linkSessionCommit(store, { sessionId: "legacy", sha: "A1B2C3D", branch: "main", kind: "committed", source: "tool", eventId: 1 });
  linkSessionCommit(store, { sessionId: "legacy", sha: "a1b2c3d", branch: "main", kind: "committed", source: "trailer", eventId: 1 });

  expect(getSessionCommits(store, "legacy")).toEqual([{ sessionId: "legacy", sha: "a1b2c3d", branch: "main", kind: "committed", source: "trailer", eventId: 1 }]);
  expect(findSessionsForCommit(store, full).map((c) => c.sessionId)).toEqual(["legacy"]);
  expect(findSessionsForCommit(store, "a1b2c3d").map((c) => c.sessionId)).toEqual(["legacy"]);
  expect(findSessionsForCommit(store, "ffffff0")).toEqual([]);
  expect(findSessionsForCommit(store, "a1b2")).toEqual([]);
  expect(findSessionsForCommit(store, "a1b2c3d%")).toEqual([]);
  expect(() => linkSessionCommit(store, { sessionId: "legacy", sha: "not-a-sha", branch: null, kind: null, source: "tool", eventId: null })).toThrow("not a commit SHA");

  // Deleting the session (as re-ingest does) removes its commit links.
  store.db.query("DELETE FROM sessions WHERE id = 'legacy'").run();
  expect(getSessionCommits(store, "legacy")).toEqual([]);
  store.db.close();
});
