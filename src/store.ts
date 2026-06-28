import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { CommandRecord, FileChangeRecord, ParsedTranscript, RiskFlagRecord, SessionSummary, StoredEvent } from "./types";
import { extractCommand, extractPath, summarizeEvent } from "./parser";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { sha256 } from "./redaction";

export type Store = {
  db: Database;
  path: string;
};

export function openStore(path = process.env.AGENTOPS_DB ?? ".agentops/agentops.db"): Store {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  migrate(db);
  return { db, path: resolved };
}

export function migrate(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      schema_version TEXT,
      source_adapter TEXT,
      agent TEXT,
      model TEXT,
      repo TEXT,
      task TEXT,
      started_at TEXT,
      ended_at TEXT,
      ingested_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      type TEXT NOT NULL,
      role TEXT,
      summary TEXT NOT NULL,
      raw_payload_hash TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      status TEXT,
      exit_code INTEGER,
      output TEXT
    );

    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      operation TEXT NOT NULL,
      lines_added INTEGER,
      lines_removed INTEGER
    );

    CREATE TABLE IF NOT EXISTS risk_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
  addColumnIfMissing(db, "sessions", "schema_version", "TEXT");
  addColumnIfMissing(db, "sessions", "source_adapter", "TEXT");
  addColumnIfMissing(db, "events", "raw_payload_hash", "TEXT");
}

export function ingestTranscript(
  store: Store,
  transcript: ParsedTranscript,
  config: AgentOpsConfig = defaultConfig
): { sessionId: string; eventCount: number } {
  const { db } = store;
  const session = transcript.session;

  const insertSession = db.query(`
    INSERT INTO sessions (id, source_path, schema_version, source_adapter, agent, model, repo, task, started_at, ended_at, ingested_at)
    VALUES ($id, $sourcePath, $schemaVersion, $sourceAdapter, $agent, $model, $repo, $task, $startedAt, $endedAt, $ingestedAt)
  `);
  const insertEvent = db.query(`
    INSERT INTO events (session_id, idx, type, role, summary, raw_payload_hash, raw_json)
    VALUES ($sessionId, $idx, $type, $role, $summary, $rawPayloadHash, $rawJson)
    RETURNING id
  `);
  const insertCommand = db.query(`
    INSERT INTO commands (session_id, event_id, command, status, exit_code, output)
    VALUES ($sessionId, $eventId, $command, $status, $exitCode, $output)
  `);
  const insertFileChange = db.query(`
    INSERT INTO file_changes (session_id, event_id, path, operation, lines_added, lines_removed)
    VALUES ($sessionId, $eventId, $path, $operation, $linesAdded, $linesRemoved)
  `);

  db.transaction(() => {
    db.query("DELETE FROM sessions WHERE id = $id").run({ $id: session.id });
    insertSession.run({
      $id: session.id,
      $sourcePath: session.sourcePath,
      $schemaVersion: session.schemaVersion ?? "agentops.event.v1",
      $sourceAdapter: session.sourceAdapter,
      $agent: session.agent ?? null,
      $model: session.model ?? null,
      $repo: session.repo ?? null,
      $task: session.task ?? null,
      $startedAt: session.startedAt ?? null,
      $endedAt: session.endedAt ?? null,
      $ingestedAt: new Date().toISOString()
    });

    transcript.events.forEach((event, idx) => {
      const type = event.type ?? inferEventType(event);
      const rawJson = JSON.stringify(event);
      const row = insertEvent.get({
        $sessionId: session.id,
        $idx: idx + 1,
        $type: type,
        $role: typeof event.role === "string" ? event.role : null,
        $summary: summarizeEvent(event),
        $rawPayloadHash: config.privacy.hashRawPayload ? sha256(rawJson) : null,
        $rawJson: config.privacy.storeRawPayload ? rawJson : ""
      }) as { id: number };

      const command = extractCommand(event);
      if (command) {
        insertCommand.run({
          $sessionId: session.id,
          $eventId: row.id,
          $command: command,
          $status: typeof event.status === "string" ? event.status : null,
          $exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
          $output: typeof event.output === "string" ? event.output : null
        });
      }

      const filePath = extractPath(event);
      if (filePath && isFileChangeType(type)) {
        insertFileChange.run({
          $sessionId: session.id,
          $eventId: row.id,
          $path: filePath,
          $operation: typeof event.operation === "string" ? event.operation : type,
          $linesAdded: typeof event.linesAdded === "number" ? event.linesAdded : null,
          $linesRemoved: typeof event.linesRemoved === "number" ? event.linesRemoved : null
        });
      }
    });
  })();

  return { sessionId: session.id, eventCount: transcript.events.length };
}

export function getSessionId(store: Store, requested: string): string | null {
  if (requested !== "latest") return requested;
  const row = store.db
    .query("SELECT id FROM sessions ORDER BY ingested_at DESC, rowid DESC LIMIT 1")
    .get() as { id: string } | null;
  return row?.id ?? null;
}

export function getSession(store: Store, sessionId: string) {
  return store.db.query("SELECT * FROM sessions WHERE id = $id").get({ $id: sessionId }) as
    | {
        id: string;
        source_path: string;
        schema_version: string | null;
        source_adapter: string | null;
        agent: string | null;
        model: string | null;
        repo: string | null;
        task: string | null;
        started_at: string | null;
        ended_at: string | null;
        ingested_at: string;
      }
    | null;
}

export function listSessions(store: Store, limit = 20): SessionSummary[] {
  return store.db
    .query(
      `
      SELECT
        sessions.id,
        sessions.source_path as sourcePath,
        sessions.schema_version as schemaVersion,
        sessions.source_adapter as sourceAdapter,
        sessions.agent,
        sessions.model,
        sessions.repo,
        sessions.task,
        sessions.started_at as startedAt,
        sessions.ended_at as endedAt,
        sessions.ingested_at as ingestedAt,
        COUNT(DISTINCT events.id) as eventCount,
        COUNT(DISTINCT commands.id) as commandCount,
        COUNT(DISTINCT file_changes.id) as fileChangeCount,
        COUNT(DISTINCT risk_flags.id) as riskCount
      FROM sessions
      LEFT JOIN events ON events.session_id = sessions.id
      LEFT JOIN commands ON commands.session_id = sessions.id
      LEFT JOIN file_changes ON file_changes.session_id = sessions.id
      LEFT JOIN risk_flags ON risk_flags.session_id = sessions.id
      GROUP BY sessions.id
      ORDER BY sessions.ingested_at DESC, sessions.rowid DESC
      LIMIT $limit
      `
    )
    .all({ $limit: limit }) as SessionSummary[];
}

export function getEvents(store: Store, sessionId: string): StoredEvent[] {
  return store.db
    .query(
      "SELECT id, idx, type, role, summary, raw_json as rawJson, raw_payload_hash as rawPayloadHash FROM events WHERE session_id = $sessionId ORDER BY idx"
    )
    .all({ $sessionId: sessionId }) as StoredEvent[];
}

export function getCommands(store: Store, sessionId: string): CommandRecord[] {
  return store.db
    .query(
      "SELECT id, event_id as eventId, command, status, exit_code as exitCode, output FROM commands WHERE session_id = $sessionId ORDER BY id"
    )
    .all({ $sessionId: sessionId }) as CommandRecord[];
}

export function getFileChanges(store: Store, sessionId: string): FileChangeRecord[] {
  return store.db
    .query(
      "SELECT id, event_id as eventId, path, operation, lines_added as linesAdded, lines_removed as linesRemoved FROM file_changes WHERE session_id = $sessionId ORDER BY path"
    )
    .all({ $sessionId: sessionId }) as FileChangeRecord[];
}

export function getRiskFlags(store: Store, sessionId: string): RiskFlagRecord[] {
  return store.db
    .query(
      "SELECT id, event_id as eventId, severity, category, message FROM risk_flags WHERE session_id = $sessionId ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id"
    )
    .all({ $sessionId: sessionId }) as RiskFlagRecord[];
}

function inferEventType(event: Record<string, unknown>): string {
  if (extractCommand(event)) return "command";
  if (extractPath(event)) return "file_read";
  return "message";
}

function isFileChangeType(type: string): boolean {
  return ["file_write", "file_edit", "write", "edit", "patch", "apply_patch"].includes(type);
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
