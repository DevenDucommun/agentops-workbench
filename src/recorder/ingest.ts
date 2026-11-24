import type { ParsedTranscript } from "../types";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { analyzeSession } from "../analyzer";
import { parseClaudeHooksJsonl } from "../claudeHooks";
import { type AgentOpsConfig, defaultConfig, loadConfig, validateConfigFile } from "../config";
import { evaluateQualityGate } from "../gate";
import { isForgotten, spoolGeneration } from "./spool";
import { getEventChain, getSessionCommits, ingestTranscript, linkSessionCommit, openStore as openStoreRaw, type SessionCommit, type Store } from "../store";

/**
 * How long, in total, one recorder import waits for other connections before
 * giving up. Long enough for a dashboard or check that holds a read snapshot
 * to finish, short enough that a store held by another writer still fails
 * within a second, inside the hook's time budget, and is recorded for replay.
 *
 * SQLite's busy timeout applies per statement, so it cannot bound a whole
 * import. Each statement waits at most STATEMENT_WAIT_MS; a "database is
 * locked" failure retries the whole operation (a single transaction, safe to
 * repeat) until the shared deadline, so the total stays near this budget.
 */
const IMPORT_BUSY_TIMEOUT_MS = 750;
const STATEMENT_WAIT_MS = 50;
let importDeadline: number | null = null;

function isBusy(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === "SQLITE_BUSY" || (typeof e?.message === "string" && /database is locked/i.test(e.message));
}

function withImportBudget<T>(run: () => T): T {
  if (importDeadline !== null) return run();
  importDeadline = Date.now() + IMPORT_BUSY_TIMEOUT_MS;
  try {
    for (;;) {
      try {
        return run();
      } catch (error) {
        if (!isBusy(error) || Date.now() >= importDeadline) throw error;
        Bun.sleepSync(Math.min(25, Math.max(1, importDeadline - Date.now())));
      }
    }
  } finally {
    importDeadline = null;
  }
}

function openStore(path: string): Store {
  const remaining = importDeadline === null ? STATEMENT_WAIT_MS : Math.max(1, importDeadline - Date.now());
  return openStoreRaw(path, { busyTimeoutMs: Math.min(STATEMENT_WAIT_MS, remaining) });
}

// Session-end ingest for the forensic recorder (spec R1.6, R1.8): spool ->
// claude-hooks adapter -> store -> analyzer, then link the session to the
// commits its Bash calls made. Loaded only on SessionEnd (and by tests), never
// on the per-tool-call hook path.

export type SpoolIngestOptions = {
  /** Enrolled repository root (real path): resolves short commit SHAs and locates config and the store. */
  repoRoot: string;
  /** Store path; defaults to `<repoRoot>/.agentops/agentops.db`, which `look` reads from the repo root. */
  dbPath?: string;
  config?: AgentOpsConfig;
  /** Config file for the turn verdict; defaults to `<repoRoot>/agentops.config.json`. */
  configPath?: string;
};

export type SpoolIngestResult = { sessionId: string; eventCount: number; commits: SessionCommit[] };

/** The spool was removed (by `recorder forget`) before it could be imported. */
export class SpoolGoneError extends Error {
  readonly code = "SPOOL_GONE";
}

export function ingestSpoolFile(spoolFile: string, options: SpoolIngestOptions): SpoolIngestResult {
  return withImportBudget(() => ingestSpoolFileWithin(spoolFile, options));
}

function ingestSpoolFileWithin(spoolFile: string, options: SpoolIngestOptions): SpoolIngestResult {
  const config = options.config ?? repoConfig(options.repoRoot);
  let content: string;
  try {
    content = readFileSync(spoolFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SpoolGoneError(`spool removed: ${spoolFile}`);
    throw error;
  }
  const generation = spoolGeneration(content);
  const transcript = parseClaudeHooksJsonl(spoolFile, content, config);
  // Hook payloads name no repository; the enrolled root's folder name stands in, as in other adapters.
  transcript.session.repo ??= basename(options.repoRoot);
  const store = openStore(options.dbPath ?? process.env.AGENTOPS_DB ?? join(options.repoRoot, ".agentops", "agentops.db"));
  try {
    // `recorder forget` records the generation it removes before deleting the
    // session's rows. Checking that record inside this write transaction orders
    // the two through SQLite's write lock: either forget's delete runs after this
    // import commits, or the import sees the record and stores nothing. A store
    // busy past IMPORT_BUSY_TIMEOUT_MS fails the import, so a hook stays within
    // its time budget and records the failure for replay.
    return storeHookTranscript(store, transcript, config, options.repoRoot, () => {
      if (generation !== null && isForgotten(spoolFile, generation)) throw new SpoolGoneError(`spool forgotten: ${spoolFile}`);
    });
  } finally {
    store.db.close();
  }
}

export function storeHookTranscript(
  store: Store,
  transcript: ParsedTranscript,
  config: AgentOpsConfig,
  repoRoot: string,
  guard: () => void = () => {}
): SpoolIngestResult {
  const run = store.db.transaction(() => {
    guard();
    // Full SHAs already known for this session (an earlier import, or a push record in this
    // transcript) resolve a short SHA the same way wherever the re-import runs.
    const isFull = (sha: string) => sha.length === 40 || sha.length === 64;
    const knownFull = new Set(getSessionCommits(store, transcript.session.id).map((commit) => commit.sha).filter(isFull));
    for (const event of transcript.events) {
      const sha = (event.gitCommit as { sha?: unknown } | undefined)?.sha;
      if (typeof sha === "string" && /^[0-9a-f]+$/i.test(sha) && isFull(sha)) knownFull.add(sha.toLowerCase());
    }
    const fromKnown = (sha: string) => {
      const matches = [...knownFull].filter((full) => full.startsWith(sha));
      return matches.length === 1 ? matches[0] : undefined;
    };
    const { sessionId, eventCount } = ingestTranscript(store, transcript, config, { rebuildToolLinks: true });
    analyzeSession(store, sessionId, config);

    const rowByEventId = new Map(getEventChain(store, sessionId).filter((row) => row.eventUid).map((row) => [row.eventUid as string, row.id]));
    for (const event of transcript.events) {
      const commit = event.gitCommit as { sha?: unknown; kind?: unknown; branch?: unknown } | undefined;
      if (typeof commit?.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(commit.sha)) continue;
      const sha = commit.sha.toLowerCase();
      const link: SessionCommit = {
        sessionId,
        sha: fromKnown(sha) ?? resolveCommit(repoRoot, sha) ?? sha,
        branch: typeof commit.branch === "string" ? commit.branch : null,
        kind: typeof commit.kind === "string" ? commit.kind : null,
        source: "tool",
        eventId: (typeof event.eventId === "string" ? rowByEventId.get(event.eventId) : undefined) ?? null
      };
      linkSessionCommit(store, link);
    }
    return { sessionId, eventCount, commits: getSessionCommits(store, sessionId) };
  });
  // Immediate: the write lock is taken before the guard runs.
  return run.immediate();
}

/**
 * One-line gate verdict for the session so far (spec R1.6, T1.6): ingests the
 * spool, runs the quality gate and summarizes it. Shown at the end of a turn
 * through the Stop hook's `systemMessage`, because Claude Code discards
 * SessionEnd hook output.
 */
export function turnVerdict(spoolFile: string, options: SpoolIngestOptions): string {
  return withImportBudget(() => turnVerdictWithin(spoolFile, options));
}

function turnVerdictWithin(spoolFile: string, options: SpoolIngestOptions): string {
  // An invalid config must not be replaced by defaults here: that would report a
  // pass that `agentops check` rejects. Say the config is invalid instead.
  let config = options.config;
  if (!config) {
    const validation = validateConfigFile(options.configPath ?? join(options.repoRoot, "agentops.config.json"));
    if (validation.errors.length) {
      const line = `agentops: needs review: invalid agentops.config.json: ${validation.errors.join("; ")} (run agentops check)`;
      return line.replace(/\s+/g, " ").slice(0, 300);
    }
    config = validation.config;
  }
  const { sessionId } = ingestSpoolFile(spoolFile, { ...options, config });
  const store = openStore(options.dbPath ?? join(options.repoRoot, ".agentops", "agentops.db"));
  try {
    const gate = evaluateQualityGate(store, sessionId, config);
    const failed = gate.checks.filter((check) => check.status === "failed");
    const detail =
      failed.length === 0 ? "all quality gates passed" : failed.map((check) => `${check.label}: ${check.message.replace(/\.$/, "")}`).join("; ");
    const line = `agentops: ${gate.status === "passed" ? "passed" : "needs review"}: ${detail} (agentops look ${sessionId})`;
    return line.replace(/\s+/g, " ").slice(0, 300);
  } finally {
    store.db.close();
  }
}

/** Full SHA for a (possibly short) commit in the repository, or null when git cannot resolve it. */
export function resolveCommit(repoRoot: string, sha: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { stdout: "pipe", stderr: "ignore" });
    const full = proc.stdout.toString().trim();
    return proc.exitCode === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(full) ? full : null;
  } catch {
    return null;
  }
}

function repoConfig(repoRoot: string): AgentOpsConfig {
  try {
    return loadConfig(join(repoRoot, "agentops.config.json"));
  } catch {
    return defaultConfig;
  }
}
