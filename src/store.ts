import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultStateDir, enrolledRepository, findRepositoryRoots } from "./recorder/enrollment";
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
import { extractCommand, extractPath, finalResponseText, summarizeEvent } from "./parser";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { sha256 } from "./redaction";

export type Store = {
  db: Database;
  path: string;
};

export function defaultStorePath(cwd = process.cwd()): string {
  if (process.env.AGENTOPS_DB !== undefined) return process.env.AGENTOPS_DB;
  const local = join(".agentops", "agentops.db");
  const enrolled = enrolledRepository(cwd, defaultStateDir());
  if (enrolled) return join(enrolled, local);
  if (existsSync(resolve(cwd, local))) return local;
  const main = findRepositoryRoots(cwd)?.main;
  return main && existsSync(join(main, local)) ? join(main, local) : local;
}

export function openStore(path = defaultStorePath(), options: { busyTimeoutMs?: number } = {}): Store {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  // Set before migrate: the migration is the first statement that can meet a lock.
  if (options.busyTimeoutMs !== undefined) db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`);
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

  // Forensic recorder (spec R1.5, R1.8, R4.3): chain and provenance fields,
  // the session chain head, and commit links. All nullable, so legacy rows and
  // older binaries keep working.
  for (const [column, definition] of eventChainColumns) addColumnIfMissing(db, "events", column, definition);
  addColumnIfMissing(db, "sessions", "chain_head_hash", "TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_commits (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sha TEXT NOT NULL,
      branch TEXT,
      kind TEXT,
      source TEXT NOT NULL,
      event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      PRIMARY KEY (session_id, sha)
    );
    CREATE INDEX IF NOT EXISTS idx_session_commits_sha ON session_commits(sha);
    CREATE INDEX IF NOT EXISTS idx_events_content_hash ON events(content_hash);
  `);
}

const eventChainColumns: Array<[string, string]> = [
  ["event_uid", "TEXT"],
  ["seq", "INTEGER"],
  ["prev_hash", "TEXT"],
  ["event_hash", "TEXT"],
  ["cwd", "TEXT"],
  ["git_head", "TEXT"],
  ["tool_use_id", "TEXT"],
  ["parent_tool_use_id", "TEXT"],
  ["agent_id", "TEXT"],
  ["content_hash", "TEXT"]
];

export function ingestTranscript(
  store: Store,
  transcript: ParsedTranscript,
  config: AgentOpsConfig = defaultConfig,
  { rebuildToolLinks = false }: { rebuildToolLinks?: boolean } = {}
): { sessionId: string; eventCount: number } {
  const { db } = store;
  // events.text is added when a store is first written, never when it is opened, so a
  // read of a store from an earlier version never writes (read-only or locked stores).
  addColumnIfMissing(db, "events", "text", "TEXT");
  addColumnIfMissing(db, "file_changes", "status", "TEXT");
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
    INSERT INTO events (
      session_id, idx, type, role, summary, text, raw_payload_hash, raw_json,
      event_uid, seq, prev_hash, event_hash, cwd, git_head, tool_use_id, parent_tool_use_id, agent_id, content_hash
    )
    VALUES (
      $sessionId, $idx, $type, $role, $summary, $text, $rawPayloadHash, $rawJson,
      $eventUid, $seq, $prevHash, $eventHash, $cwd, $gitHead, $toolUseId, $parentToolUseId, $agentId, $contentHash
    )
    RETURNING id
  `);
  const insertCommand = db.query(`
    INSERT INTO commands (session_id, event_id, command, status, exit_code, output)
    VALUES ($sessionId, $eventId, $command, $status, $exitCode, $output)
  `);
  const insertFileChange = db.query(`
    INSERT INTO file_changes (session_id, event_id, path, operation, status, lines_added, lines_removed)
    VALUES ($sessionId, $eventId, $path, $operation, $status, $linesAdded, $linesRemoved)
  `);
  const insertToolCall = db.query(`
    INSERT INTO tool_calls (session_id, event_id, tool_name, category, status)
    VALUES ($sessionId, $eventId, $toolName, $category, $status)
  `);

  db.transaction(() => {
    // Deleting the old session cascades to its commit links. Recorder imports
    // rebuild tool-derived links from the spool; other links belong to the session.
    const links = db.query(`
      SELECT c.session_id AS sessionId, c.sha, c.branch, c.kind, c.source,
             e.idx, e.raw_payload_hash AS payloadHash, e.event_hash AS eventHash
      FROM session_commits c LEFT JOIN events e ON e.id = c.event_id AND e.session_id = c.session_id
      WHERE c.session_id = ? AND (? = 0 OR c.source != 'tool')
    `).all(session.id, Number(rebuildToolLinks)) as Array<Omit<SessionCommit, "eventId"> & {
      idx: number | null; payloadHash: string | null; eventHash: string | null;
    }>;
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

    // A start event whose invocation also has a finish event stays in the timeline
    // but is not a second tool call. Unmatched starts (denied, interrupted) still count.
    const finishedToolUseIds = new Set(
      transcript.events
        .filter((e) => e.type !== "tool_started" && typeof e.toolUseId === "string")
        .map((e) => e.toolUseId as string)
    );

    transcript.events.forEach((event, idx) => {
      const type = event.type ?? inferEventType(event);
      const rawJson = JSON.stringify(event);
      const row = insertEvent.get({
        $sessionId: session.id,
        $idx: idx + 1,
        $type: type,
        $role: typeof event.role === "string" ? event.role : null,
        $summary: summarizeEvent(event),
        $text: finalResponseText(event),
        $rawPayloadHash: config.privacy.hashRawPayload ? sha256(rawJson) : null,
        $rawJson: config.privacy.storeRawPayload ? rawJson : "",
        ...eventChainParams(event)
      }) as { id: number };

      const command = extractCommand(event);
      const toolName = extractToolName(event, command);
      const startOfFinished = type === "tool_started" && typeof event.toolUseId === "string" && finishedToolUseIds.has(event.toolUseId);
      if (toolName && !startOfFinished) {
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
          $status: typeof event.status === "string" ? event.status : null,
          $operation: typeof event.operation === "string" ? event.operation : type,
          $linesAdded: typeof event.linesAdded === "number" ? event.linesAdded : null,
          $linesRemoved: typeof event.linesRemoved === "number" ? event.linesRemoved : null
        });
      }
    });

    for (const link of links) {
      // SQLite row ids change at each import. Reattach only when the same
      // timeline step still contains the same event, otherwise keep the link uncited.
      const event = db.query(`SELECT id FROM events WHERE session_id = ? AND idx = ?
        AND CASE WHEN raw_payload_hash IS NOT NULL AND ? IS NOT NULL THEN raw_payload_hash = ? ELSE event_hash = ? END`)
        .get(session.id, link.idx, link.payloadHash, link.payloadHash, link.eventHash) as { id: number } | null;
      linkSessionCommit(store, { ...link, eventId: event?.id ?? null });
    }
  }).immediate();

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
  // A read-only store written by an earlier version has no text column; read it as NULL.
  const text = hasColumn(store.db, "events", "text") ? "text" : "NULL AS text";
  return store.db
    .query(
      `SELECT id, idx, type, role, summary, ${text}, raw_json as rawJson, raw_payload_hash as rawPayloadHash FROM events WHERE session_id = $sessionId ORDER BY idx`
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

/** Older imports may have captured an edit outcome only on the tool call. */
export function getUnconfirmedFileEvents(store: Store, sessionId: string): Set<number> {
  const status = hasColumn(store.db, "file_changes", "status") ? "COALESCE(f.status, t.status)" : "t.status";
  const rows = store.db.query(`
    SELECT f.event_id AS eventId FROM file_changes f
    LEFT JOIN tool_calls t ON t.session_id = f.session_id AND t.event_id = f.event_id
    WHERE f.session_id = $sid AND f.event_id IS NOT NULL
      AND (LOWER(${status}) IN ('skipped', 'timed_out', 'timeout', 'no_result', 'interrupted', 'inferred',
            'failed', 'error', 'denied', 'declined', 'rejected', 'cancelled', 'canceled', 'aborted', 'killed',
            'started', 'running', 'in_progress', 'pending', 'queued')
           OR LOWER(f.operation) = 'inferred edit')
  `).all({ $sid: sessionId }) as Array<{ eventId: number }>;
  return new Set(rows.map(row => row.eventId));
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
  if (["web_search", "WebSearch", "WebFetch"].includes(toolName) || toolName.toLowerCase().includes("web_search")) return "web";
  if (toolName.startsWith("mcp__")) return "mcp";
  if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "apply_patch"].includes(toolName) || eventType.startsWith("file_")) return "file";
  return "other";
}

// Only well-typed values are stored; anything else becomes NULL.
function eventChainParams(event: RawEvent) {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    $eventUid: text(event.eventId),
    $seq: Number.isSafeInteger(event.seq) ? (event.seq as number) : null,
    $prevHash: text(event.prevHash),
    $eventHash: text(event.hash),
    $cwd: text(event.cwd),
    $gitHead: text(event.gitHead),
    $toolUseId: text(event.toolUseId),
    $parentToolUseId: text(event.parentToolUseId),
    $agentId: text(event.agentId),
    $contentHash: text(event.contentHash)
  };
}

export type EventChainRow = {
  id: number;
  idx: number;
  eventUid: string | null;
  seq: number | null;
  prevHash: string | null;
  eventHash: string | null;
  cwd: string | null;
  gitHead: string | null;
  toolUseId: string | null;
  parentToolUseId: string | null;
  agentId: string | null;
  contentHash: string | null;
};

export function getEventChain(store: Store, sessionId: string): EventChainRow[] {
  return store.db
    .query(
      `SELECT id, idx, event_uid AS eventUid, seq, prev_hash AS prevHash, event_hash AS eventHash, cwd,
        git_head AS gitHead, tool_use_id AS toolUseId, parent_tool_use_id AS parentToolUseId,
        agent_id AS agentId, content_hash AS contentHash
      FROM events WHERE session_id = $sessionId ORDER BY idx`
    )
    .all({ $sessionId: sessionId }) as EventChainRow[];
}

export type SessionCommit = {
  sessionId: string;
  sha: string;
  branch: string | null;
  kind: string | null;
  source: "tool" | "trailer";
  eventId: number | null;
};

/** Links a commit to a session (R1.8). Re-linking the same SHA updates the row. */
export function linkSessionCommit(store: Store, commit: SessionCommit): void {
  if (!/^[0-9a-f]{7,64}$/i.test(commit.sha)) throw new Error(`linkSessionCommit: not a commit SHA: ${commit.sha}`);
  store.db
    .query(
      `INSERT INTO session_commits (session_id, sha, branch, kind, source, event_id)
      VALUES ($sessionId, $sha, $branch, $kind, $source, $eventId)
      ON CONFLICT (session_id, sha) DO UPDATE SET
        branch = excluded.branch, kind = excluded.kind, source = excluded.source, event_id = excluded.event_id`
    )
    .run({
      $sessionId: commit.sessionId,
      $sha: commit.sha.toLowerCase(),
      $branch: commit.branch,
      $kind: commit.kind,
      $source: commit.source,
      $eventId: commit.eventId
    });
}

export function getSessionCommits(store: Store, sessionId: string): SessionCommit[] {
  return store.db
    .query(
      `SELECT session_id AS sessionId, sha, branch, kind, source, event_id AS eventId
      FROM session_commits WHERE session_id = $sessionId ORDER BY rowid`
    )
    .all({ $sessionId: sessionId }) as SessionCommit[];
}

/**
 * Sessions linked to a commit. SHAs of 7+ hex characters match by prefix in
 * either direction, because Claude Code reports short SHAs (spike S1).
 */
export function findSessionsForCommit(store: Store, sha: string): SessionCommit[] {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return [];
  const needle = sha.toLowerCase();
  return store.db
    .query(
      `SELECT session_id AS sessionId, sha, branch, kind, source, event_id AS eventId
      FROM session_commits
      WHERE sha LIKE $prefix OR (length(sha) < length($sha) AND substr($sha, 1, length(sha)) = sha)
      ORDER BY rowid`
    )
    .all({ $sha: needle, $prefix: `${needle}%` }) as SessionCommit[];
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((row) => row.name === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
