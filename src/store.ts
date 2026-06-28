import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  CommandRecord,
  FileChangeRecord,
  ParsedTranscript,
  RawEvent,
  RiskFlagRecord,
  SessionSummary,
  StoredEvent,
  ToolCallRecord,
  UsageInput,
  UsageSummary
} from "./types";
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
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      cost_amount REAL,
      cost_currency TEXT,
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

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT
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
  addColumnIfMissing(db, "sessions", "input_tokens", "INTEGER");
  addColumnIfMissing(db, "sessions", "output_tokens", "INTEGER");
  addColumnIfMissing(db, "sessions", "total_tokens", "INTEGER");
  addColumnIfMissing(db, "sessions", "cost_amount", "REAL");
  addColumnIfMissing(db, "sessions", "cost_currency", "TEXT");
  addColumnIfMissing(db, "events", "raw_payload_hash", "TEXT");
}

export function ingestTranscript(
  store: Store,
  transcript: ParsedTranscript,
  config: AgentOpsConfig = defaultConfig
): { sessionId: string; eventCount: number } {
  const { db } = store;
  const session = transcript.session;
  const usage = deriveUsageSummary(session.usage, transcript.events);

  const insertSession = db.query(`
    INSERT INTO sessions (
      id, source_path, schema_version, source_adapter, agent, model, repo, task, started_at, ended_at,
      input_tokens, output_tokens, total_tokens, cost_amount, cost_currency, ingested_at
    )
    VALUES (
      $id, $sourcePath, $schemaVersion, $sourceAdapter, $agent, $model, $repo, $task, $startedAt, $endedAt,
      $inputTokens, $outputTokens, $totalTokens, $costAmount, $costCurrency, $ingestedAt
    )
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
  const insertToolCall = db.query(`
    INSERT INTO tool_calls (session_id, event_id, tool_name, category, status)
    VALUES ($sessionId, $eventId, $toolName, $category, $status)
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
      $inputTokens: usage.inputTokens,
      $outputTokens: usage.outputTokens,
      $totalTokens: usage.totalTokens,
      $costAmount: usage.costAmount,
      $costCurrency: usage.costCurrency,
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
      const toolName = extractToolName(event, command);
      if (toolName) {
        insertToolCall.run({
          $sessionId: session.id,
          $eventId: row.id,
          $toolName: toolName,
          $category: categorizeTool(toolName, type),
          $status: typeof event.status === "string" ? event.status : null
        });
      }

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
        input_tokens: number | null;
        output_tokens: number | null;
        total_tokens: number | null;
        cost_amount: number | null;
        cost_currency: string | null;
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
        COUNT(DISTINCT risk_flags.id) as riskCount,
        sessions.total_tokens as totalTokens
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

export function getUsageSummary(store: Store, sessionId: string): UsageSummary {
  const row = store.db
    .query(
      `
      SELECT
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        total_tokens as totalTokens,
        cost_amount as costAmount,
        cost_currency as costCurrency
      FROM sessions
      WHERE id = $sessionId
      `
    )
    .get({ $sessionId: sessionId }) as UsageSummary | null;

  return (
    row ?? {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costAmount: null,
      costCurrency: null
    }
  );
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

export function getToolCalls(store: Store, sessionId: string): ToolCallRecord[] {
  return store.db
    .query(
      `
      SELECT
        MIN(id) as id,
        MIN(event_id) as eventId,
        tool_name as toolName,
        category,
        status,
        COUNT(*) as count
      FROM tool_calls
      WHERE session_id = $sessionId
      GROUP BY tool_name, category, status
      ORDER BY count DESC, tool_name
      `
    )
    .all({ $sessionId: sessionId }) as ToolCallRecord[];
}

function inferEventType(event: Record<string, unknown>): string {
  if (extractCommand(event)) return "command";
  if (extractPath(event)) return "file_read";
  return "message";
}

function isFileChangeType(type: string): boolean {
  return ["file_write", "file_edit", "write", "edit", "patch", "apply_patch"].includes(type);
}

function extractToolName(event: RawEvent, command: string | null): string | null {
  if (typeof event.toolName === "string" && event.toolName.trim()) return event.toolName.trim();
  if (command) return "shell";
  return null;
}

function categorizeTool(toolName: string, eventType: string): ToolCallRecord["category"] {
  if (toolName === "shell" || toolName === "Bash" || toolName === "functions.exec_command" || eventType === "command") return "shell";
  if (toolName === "web_search" || toolName.toLowerCase().includes("web_search")) return "web";
  if (toolName.startsWith("mcp__")) return "mcp";
  if (["Read", "Write", "Edit", "MultiEdit", "apply_patch"].includes(toolName) || eventType.startsWith("file_")) return "file";
  return "other";
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function deriveUsageSummary(sessionUsage: UsageInput | undefined, events: RawEvent[]): UsageSummary {
  const fromSession = normalizeUsage(sessionUsage);
  if (hasUsage(fromSession)) return withDerivedTotal(fromSession);

  const usageItems = events.map((event) => normalizeUsage(event.usage)).filter(hasUsage);
  if (usageItems.length === 0) return emptyUsage();

  const summary = usageItems.reduce((accumulator, usage) => mergeUsage(accumulator, usage), emptyUsage());
  return withDerivedTotal(summary);
}

function normalizeUsage(usage: UsageInput | undefined): UsageSummary {
  if (!usage || typeof usage !== "object") return emptyUsage();

  const cost = normalizeCost(usage);
  return {
    inputTokens: positiveInteger(usage.inputTokens),
    outputTokens: positiveInteger(usage.outputTokens),
    totalTokens: positiveInteger(usage.totalTokens),
    costAmount: cost.amount,
    costCurrency: cost.currency
  };
}

function normalizeCost(usage: UsageInput): { amount: number | null; currency: string | null } {
  if (typeof usage.costUsd === "number") return { amount: positiveNumber(usage.costUsd), currency: "USD" };
  if (typeof usage.costAmount === "number") return { amount: positiveNumber(usage.costAmount), currency: normalizeCurrency(usage.costCurrency) };
  if (typeof usage.totalCost === "number") return { amount: positiveNumber(usage.totalCost), currency: normalizeCurrency(usage.costCurrency) };
  if (typeof usage.cost === "number") return { amount: positiveNumber(usage.cost), currency: normalizeCurrency(usage.costCurrency) };
  if (usage.cost && typeof usage.cost === "object") {
    return {
      amount: positiveNumber(usage.cost.amount),
      currency: normalizeCurrency(usage.cost.currency ?? usage.costCurrency)
    };
  }
  return { amount: null, currency: null };
}

function mergeUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
  return {
    inputTokens: sumNullable(left.inputTokens, right.inputTokens),
    outputTokens: sumNullable(left.outputTokens, right.outputTokens),
    totalTokens: sumNullable(left.totalTokens, right.totalTokens),
    costAmount: sumNullable(left.costAmount, right.costAmount),
    costCurrency: mergeCurrency(left.costCurrency, right.costCurrency)
  };
}

function withDerivedTotal(usage: UsageSummary): UsageSummary {
  if (usage.totalTokens !== null) return usage;
  if (usage.inputTokens === null && usage.outputTokens === null) return usage;
  return {
    ...usage,
    totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  };
}

function hasUsage(usage: UsageSummary): boolean {
  return (
    usage.inputTokens !== null ||
    usage.outputTokens !== null ||
    usage.totalTokens !== null ||
    usage.costAmount !== null ||
    usage.costCurrency !== null
  );
}

function emptyUsage(): UsageSummary {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costAmount: null,
    costCurrency: null
  };
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().toUpperCase();
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

function mergeCurrency(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right || left === right) return left;
  return "MIXED";
}
