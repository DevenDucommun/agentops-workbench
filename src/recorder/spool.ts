import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { eventHash, eventIdFor } from "../eventChain";
import { redactValue, sha256 } from "../redaction";
import type { RawEvent } from "../types";

// Spool writer for the forensic recorder (spec R1.2-R1.5, plan M1.2).
// One append-only JSONL file per session, outside the repo checkout. Each
// record is redacted, privacy-transformed and hash-chained before it is
// written. A per-session lock file serializes concurrent hook processes so
// `seq` stays continuous and the chain stays valid. Nothing here throws to the
// caller: hooks must always exit 0 (R1.4).
//
// Kept free of heavy imports (no SQLite, analyzer or CLI) so the hook entry
// stays inside its latency budget (spike S1).

export type SpoolOptions = {
  /** Keep file contents and command output instead of length + sha256 (privacy.storeRawPayload). */
  storeRawPayload?: boolean;
  /** Records larger than this have their payload replaced by a digest. */
  maxRecordBytes?: number;
  /** How long to wait for the session lock before giving up. */
  lockTimeoutMs?: number;
  /** A lock older than this is treated as abandoned by a crashed writer. */
  staleLockMs?: number;
  /** Clock override for tests. */
  now?: () => Date;
};

export type AppendResult =
  | { ok: true; path: string; seq: number; hash: string; truncated: boolean }
  | { ok: false; reason: "lock-timeout" | "write-failed" | "invalid-session"; detail: string };

export const SPOOL_RECORD_TYPE = "claude_hook";
export const RECORDER_ERROR_TYPE = "agentops.recorder_error";

const DEFAULTS = { maxRecordBytes: 1024 * 1024, lockTimeoutMs: 250, staleLockMs: 5000 };

// Payload keys whose string values are file contents or command output (R1.3).
const CONTENT_KEYS = new Set(["content", "old_string", "new_string", "originalFile", "oldString", "newString", "stdout", "stderr", "error", "lines"]);
// Private transcript paths are never spooled (spec non-goal: no transcript parsing).
const DROPPED_KEYS = new Set(["transcript_path", "agent_transcript_path"]);
const MAX_LINE_HASHES = 5000;

/** `$AGENTOPS_STATE_DIR`, else `$XDG_STATE_HOME/agentops`, else `~/.local/state/agentops`; spools live in `spool/`. */
export function defaultSpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.AGENTOPS_STATE_DIR || (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "agentops") : join(homedir(), ".local", "state", "agentops"));
  return join(base, "spool");
}

/** Session IDs become file names, so only a safe charset is used directly; anything else is hashed. */
export function spoolFileName(sessionId: string): string | null {
  if (!sessionId) return null;
  return /^[A-Za-z0-9-]{1,64}$/.test(sessionId) ? `${sessionId}.jsonl` : `sid-${sha256(sessionId).slice(0, 32)}.jsonl`;
}

export function spoolPath(dir: string, sessionId: string): string | null {
  const name = spoolFileName(sessionId);
  return name ? join(dir, name) : null;
}

/**
 * Builds the spool record for one hook payload (without chain fields):
 * lifts the identifiers the adapter needs, computes content hashes, then
 * redacts and privacy-transforms the payload.
 */
export function buildSpoolRecord(payload: Record<string, unknown>, options: SpoolOptions = {}): RawEvent {
  const now = (options.now ?? (() => new Date()))();
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : undefined;
  const toolResponse = isRecord(payload.tool_response) ? payload.tool_response : undefined;

  const record: RawEvent = {
    schemaVersion: "agentops.event.v1",
    type: SPOOL_RECORD_TYPE,
    source: "claude-code",
    timestamp: now.toISOString(),
    hookEventName: str(payload.hook_event_name),
    toolName: str(payload.tool_name),
    toolUseId: str(payload.tool_use_id),
    promptId: str(payload.prompt_id),
    agentId: str(payload.agent_id),
    agentType: str(payload.agent_type),
    cwd: str(payload.cwd)
  };

  const exitCode = typeof payload.error === "string" ? /^Exit code (\d+)/.exec(payload.error)?.[1] : undefined;
  if (exitCode !== undefined) record.exitCode = Number(exitCode);

  const written = writtenContent(toolInput, toolResponse);
  if (written !== undefined) record.contentHash = sha256(written.content);
  const addedLines = written?.addedLines ?? [];
  if (addedLines.length > 0) record.addedLineHashes = addedLines.slice(0, MAX_LINE_HASHES).map((line) => sha256(line.replace(/\r$/, "")));

  record.payload = transformPayload(payload, options.storeRawPayload === true, "");
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return redactValue(record);
}

/**
 * Appends one hook payload to the session's spool. Never throws. On lock
 * timeout or a write failure the record is not chained into the spool; an
 * `agentops.recorder_error` line goes to `<session>.errors.jsonl` instead.
 */
export function appendHookPayload(dir: string, payload: Record<string, unknown>, options: SpoolOptions = {}): AppendResult {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const path = spoolPath(dir, sessionId);
  if (!path) return { ok: false, reason: "invalid-session", detail: "payload has no session_id" };
  let record: RawEvent;
  try {
    record = buildSpoolRecord(payload, options);
  } catch (error) {
    return fail(dir, sessionId, "write-failed", `build: ${message(error)}`);
  }
  return appendRecord(dir, sessionId, record, options);
}

/** Chains and appends an already-built record under the session lock. Never throws. */
export function appendRecord(dir: string, sessionId: string, record: RawEvent, options: SpoolOptions = {}): AppendResult {
  const path = spoolPath(dir, sessionId);
  if (!path) return { ok: false, reason: "invalid-session", detail: "empty session id" };
  const settings = { ...DEFAULTS, ...options };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: `mkdir: ${message(error)}` };
  }

  const lockPath = `${path}.lock`;
  const lock = acquireLock(lockPath, settings.lockTimeoutMs, settings.staleLockMs);
  if (lock !== "acquired") {
    return lock === "timeout"
      ? fail(dir, sessionId, "lock-timeout", `lock not acquired within ${settings.lockTimeoutMs} ms`)
      : fail(dir, sessionId, "write-failed", `lock: ${lock.error}`);
  }
  try {
    const tail = readTail(path);
    const seq = tail ? tail.seq + 1 : 1;
    let linked: RawEvent = { ...record, eventId: eventIdFor(sessionId, seq), seq, prevHash: tail ? tail.hash : null };
    linked.hash = eventHash(linked);
    let line = JSON.stringify(linked);
    let truncated = false;
    if (Buffer.byteLength(line) > settings.maxRecordBytes) {
      const payloadJson = JSON.stringify(record.payload ?? null);
      const { hash: _h, ...rest } = linked;
      linked = { ...rest, truncated: true, payload: { omitted: "payload", bytes: Buffer.byteLength(payloadJson), sha256: sha256(payloadJson) } };
      linked.hash = eventHash(linked);
      line = JSON.stringify(linked);
      truncated = true;
    }
    const prefix = tail && !tail.endsWithNewline ? "\n" : "";
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, `${prefix}${line}\n`);
    } finally {
      closeSync(fd);
    }
    return { ok: true, path, seq, hash: linked.hash as string, truncated };
  } catch (error) {
    return fail(dir, sessionId, "write-failed", message(error));
  } finally {
    releaseLock(lockPath);
  }
}

/** Reads a spool file: parsed records in order, plus the 1-based line numbers that failed to parse. */
export function readSpool(path: string): { records: RawEvent[]; invalidLines: number[] } {
  const records: RawEvent[] = [];
  const invalidLines: number[] = [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { records, invalidLines };
  }
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed as RawEvent);
      else invalidLines.push(i + 1);
    } catch {
      invalidLines.push(i + 1);
    }
  });
  return { records, invalidLines };
}

// --- privacy transform -------------------------------------------------------

function transformPayload(value: unknown, keepRaw: boolean, key: string): unknown {
  if (Array.isArray(value)) {
    if (!keepRaw && key === "lines" && value.every((v) => typeof v === "string")) return digest(value.join("\n"));
    return value.map((item) => transformPayload(item, keepRaw, ""));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROPPED_KEYS.has(k)) continue;
      // PostToolBatch repeats each result as model-facing text (spike S1).
      if (!keepRaw && k === "tool_response" && typeof v === "string") {
        out[k] = digest(v);
        continue;
      }
      out[k] = transformPayload(v, keepRaw, k);
    }
    return out;
  }
  if (!keepRaw && typeof value === "string" && CONTENT_KEYS.has(key)) return digest(value);
  return value;
}

function digest(text: string) {
  return { omitted: "content", bytes: Buffer.byteLength(text), sha256: sha256(text) };
}

/** Full file content after a Write or Edit, when the payload allows rebuilding it. */
function writtenContent(input: Record<string, unknown> | undefined, response: Record<string, unknown> | undefined): { content: string; addedLines: string[] } | undefined {
  if (!input) return undefined;
  if (typeof input.content === "string" && typeof input.file_path === "string") {
    return { content: input.content, addedLines: input.content.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "")) };
  }
  const original = response?.originalFile;
  if (typeof original === "string" && typeof input.old_string === "string" && typeof input.new_string === "string" && original.includes(input.old_string)) {
    const replacement = input.new_string;
    const content = input.replace_all === true ? original.split(input.old_string).join(replacement) : original.replace(input.old_string, () => replacement);
    const patch = Array.isArray(response?.structuredPatch) ? response.structuredPatch : [];
    const addedLines = patch.flatMap((hunk) => (isRecord(hunk) && Array.isArray(hunk.lines) ? hunk.lines : []))
      .filter((l): l is string => typeof l === "string" && l.startsWith("+"))
      .map((l) => l.slice(1));
    return { content, addedLines };
  }
  return undefined;
}

// --- tail recovery -----------------------------------------------------------

/** Last chained record in the file (scanning back past torn or foreign lines). */
function readTail(path: string): { seq: number; hash: string; endsWithNewline: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    const endsWithNewline = last[0] === 0x0a;
    for (let chunk = 64 * 1024; ; chunk *= 2) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (isRecord(parsed) && Number.isSafeInteger(parsed.seq) && typeof parsed.hash === "string") {
            return { seq: parsed.seq as number, hash: parsed.hash, endsWithNewline };
          }
        } catch {
          // Torn line from a crashed writer; keep scanning back.
        }
      }
      if (start === 0) return null;
    }
  } finally {
    closeSync(fd);
  }
}

// --- locking -----------------------------------------------------------------

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): "acquired" | "timeout" | { error: string } {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return "acquired";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { error: message(error) };
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
        unlinkSync(lockPath);
        continue;
      }
    } catch {
      continue; // Lock vanished between open and stat; retry at once.
    }
    if (Date.now() >= deadline) return "timeout";
    sleepMs(1 + Math.floor(Math.random() * 3));
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone (stale-lock cleanup by another writer).
  }
}

// --- errors ------------------------------------------------------------------

function fail(dir: string, sessionId: string, reason: "lock-timeout" | "write-failed", detail: string): AppendResult {
  writeRecorderError(dir, sessionId, reason, detail);
  return { ok: false, reason, detail };
}

/** Best-effort, unchained error line in `<session>.errors.jsonl`. Never throws. */
export function writeRecorderError(dir: string, sessionId: string, reason: string, detail: string): void {
  const name = spoolFileName(sessionId);
  if (!name) return;
  try {
    const line = JSON.stringify({ schemaVersion: "agentops.event.v1", type: RECORDER_ERROR_TYPE, timestamp: new Date().toISOString(), reason, detail: redactValue(detail).slice(0, 500) });
    appendFileSync(join(dir, name.replace(/\.jsonl$/, ".errors.jsonl")), `${line}\n`, { mode: 0o600 });
  } catch {
    // Nowhere left to report; the hook still exits 0.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
