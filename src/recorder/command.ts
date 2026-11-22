import { appendFileSync, existsSync, readdirSync, statSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defaultStateDir, enrolledRepository, enrollRepository, findRepositoryRoots, unenrollRepository } from "./enrollment";
import { forgottenPath, spoolGeneration, spoolPath, unforget, withSpoolLock } from "./spool";

// `agentops recorder enable|disable|status|forget` (spec R1.7). Dispatched from
// src/main.ts like `hook`, so it works in the release binary and `bun run
// agentops`. Enrollment is per repository and lives in the user state dir.

export const PLUGIN_INSTALL = "/plugin install agentops-recorder --marketplace DevenDucommun/agentops-workbench";

export type CommandResult = { stdout: string; stderr?: string; exitCode: number };
export type RecorderCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

const USAGE = "Usage: agentops recorder enable|disable|status\n       agentops recorder forget <session-id>\n";

export async function runRecorderCommand(args: string[], options: RecorderCommandOptions = {}): Promise<CommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stateDir = defaultStateDir(env);
  const roots = findRepositoryRoots(cwd);
  const [sub] = args;

  if (sub !== "enable" && sub !== "disable" && sub !== "status" && sub !== "forget") return { stdout: "", stderr: USAGE, exitCode: 1 };
  if (sub === "forget" && (args.length !== 2 || !args[1])) return { stdout: "", stderr: USAGE, exitCode: 1 };
  if (!roots) return { stdout: "", stderr: `Not inside a git repository: ${cwd}\nThe recorder is enabled per repository; run this from the repository you want recorded.\n`, exitCode: 1 };

  if (sub === "enable") {
    const repo = enrollRepository(cwd, stateDir);
    const lines = [
      `Recorder enabled for ${repo}.`,
      `Claude Code sessions here are recorded once the plugin is installed: ${PLUGIN_INSTALL}`
    ];
    if (!binaryOnPath(env)) lines.push(`Warning: the agentops binary is not on PATH, so the plugin's hooks will do nothing. Install it (docs/INSTALLATION.md) or set AGENTOPS_BIN.`);
    if (!gitignoresAgentops(repo)) lines.push("Warning: .agentops/ is not in .gitignore; recorded sessions are stored there. Run `agentops init` or add it.");
    return { stdout: `${lines.join("\n")}\n`, exitCode: 0 };
  }

  if (sub === "forget") return forgetSession(args[1] as string, forgetStores(cwd, env, roots.main, stateDir), join(stateDir, "spool"));

  if (sub === "disable") {
    const removed = unenrollRepository(cwd, stateDir);
    const text = removed
      ? `Recorder disabled for ${roots.main}. New sessions are not recorded. Existing spools stay in ${join(stateDir, "spool")} and imported sessions stay in ${recorderStore(cwd, env, roots.main)} until you remove them (docs/RECORDER.md, "Removing recorded data").`
      : `Recorder was not enabled for ${roots.main}.`;
    return { stdout: `${text}\n`, exitCode: 0 };
  }

  const enrolled = enrolledRepository(cwd, stateDir) !== null;
  // Status reports what the hook and `agentops check` use from this directory:
  // AGENTOPS_DB resolved against the real working directory when set, otherwise
  // the repository's shared store; the turn-end verdict follows this directory's
  // agentops.config.json, or the checkout root's when it has none.
  const here = realDirectory(cwd) ?? cwd;
  const store = recorderStore(cwd, env, roots.main);
  const verdictConfigDir = existsSync(join(here, "agentops.config.json")) ? here : roots.checkout;
  const lines = [
    `Repository: ${roots.main}${roots.checkout !== roots.main ? ` (worktree ${roots.checkout})` : ""}`,
    `Recorder: ${enrolled ? "enabled" : "disabled"}`,
    `agentops binary on PATH: ${binaryOnPath(env) ? "yes" : "no"}`,
    `Turn-end verdict (recorder.verdict): ${configFlag(verdictConfigDir, "recorder", "verdict") === true ? "on" : "off"}`,
    `State directory: ${stateDir}`,
    `Recorded sessions in ${store}: ${await recordedSessions(store)}`,
    `Plugin install: ${PLUGIN_INSTALL}`
  ];
  return { stdout: `${lines.join("\n")}\n`, exitCode: 0 };
}

/**
 * Removes one recorded session: its rows in the repository's store (events,
 * commands, files, flags and commit links cascade) and its spool and error
 * files, under the session's spool lock. Nothing else is touched, so other
 * sessions keep verifying.
 */
async function forgetSession(sessionId: string, stores: string[], spoolDir: string): Promise<CommandResult> {
  const { Database } = await import("bun:sqlite");
  // Hold the session's spool lock for the whole removal: a hook appending at
  // the same moment would otherwise recreate the spool mid-chain after it was
  // deleted. A held lock is never reclaimed, however old (a slow writer may still
  // be running); forget waits briefly, then gives up and deletes nothing.
  let locked: ReturnType<typeof withSpoolLock<string[]>>;
  try {
  locked = withSpoolLock(
    spoolDir,
    sessionId,
    () => {
      const removed: string[] = [];
      const spool = spoolPath(spoolDir, sessionId) as string;
      // Exact names only: on a case-insensitive volume another spelling of the id
      // would otherwise reach this session's spool while SQLite matches exactly.
      const present = existingExactly(spoolDir);
      const spoolExists = present.has(basename(spool));
      // Record the generation being removed before the rows go: an import of it
      // that is already running checks this inside its write transaction, so it
      // either commits before the delete below or stores nothing.
      const generation = spoolExists ? spoolGeneration(readFileSync(spool, "utf8")) : null;
      if (generation !== null) appendFileSync(forgottenPath(spool), `${generation}\n`, { mode: 0o600 });
      try {
        for (const store of stores) {
          if (!storeExists(store)) continue;
          const db = new Database(store);
          try {
            db.exec(`PRAGMA busy_timeout = ${FORGET_STORE_BUSY_TIMEOUT_MS}`);
            db.exec("PRAGMA foreign_keys = ON");
            // Exact id only. A redacted id is shared by every id of its kind, so it
            // never identifies one session.
            const result = db.query("DELETE FROM sessions WHERE id = $id").run({ $id: sessionId });
            if (result.changes > 0) removed.push(`session ${sessionId} from ${store}`);
          } finally {
            db.close();
          }
        }
      } catch (error) {
        // Nothing was deleted: later imports of this spool must still happen.
        if (generation !== null) unforget(spool, generation);
        throw error;
      }
      for (const file of [spool, spool.replace(/\.jsonl$/, ".errors.jsonl")]) {
        if (!present.has(basename(file))) continue;
        rmSync(file, { force: true });
        removed.push(file);
      }
      return removed;
    },
    { lockTimeoutMs: FORGET_LOCK_TIMEOUT_MS, staleLockMs: Number.POSITIVE_INFINITY }
  );
  } catch (error) {
    // Listing, reading and the store delete fail before anything is removed; run
    // forget again once the cause is fixed to finish.
    return { stdout: "", stderr: `Could not forget session ${sessionId}: ${error instanceof Error ? error.message : String(error)}. Run it again once this is fixed.\n`, exitCode: 1 };
  }
  if (!locked.ok) {
    const busy = locked.reason === "lock-timeout";
    return {
      stdout: "",
      stderr: busy
        ? `Session ${sessionId} is being recorded right now (its spool is locked). Nothing was removed; try again when the session has ended. If no session is running, a crashed hook left ${spoolPath(spoolDir, sessionId)}.lock behind; delete it and retry.\n`
        : `Could not lock session ${sessionId}: ${locked.detail}. Nothing was removed.\n`,
      exitCode: 1
    };
  }
  const removed = locked.value;
  if (!removed.length) return { stdout: `Nothing recorded for session ${sessionId}.\n`, exitCode: 0 };
  return { stdout: `Removed:\n${removed.map((item) => `- ${item}`).join("\n")}\n`, exitCode: 0 };
}

/** How long forget waits for a hook to finish appending before giving up. */
const FORGET_LOCK_TIMEOUT_MS = 2000;
/**
 * How long forget waits for a running import to commit before giving up. Kept
 * well under the hooks' five-second stale-lock limit, so a hook never treats the
 * lock forget holds as abandoned.
 */
const FORGET_STORE_BUSY_TIMEOUT_MS = 2500;

/**
 * Whether the store exists. Only a missing file means there is none; a store
 * that cannot be reached (a directory without permission) is an error, so
 * forget stops before removing the spool instead of reporting success.
 */
function storeExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** File names in a directory, exactly as stored. A missing directory has none; any other error propagates. */
function existingExactly(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

function binaryOnPath(env: NodeJS.ProcessEnv): boolean {
  return Bun.which(env.AGENTOPS_BIN || "agentops", { PATH: env.PATH ?? "" }) !== null;
}

function gitignoresAgentops(repo: string): boolean {
  try {
    return readFileSync(join(repo, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .some((line) => /^\/?\.agentops\/?$/.test(line.trim()));
  } catch {
    return false;
  }
}

function configFlag(repo: string, section: string, key: string): unknown {
  try {
    return JSON.parse(readFileSync(join(repo, "agentops.config.json"), "utf8"))?.[section]?.[key];
  } catch {
    return undefined;
  }
}

async function recordedSessions(store: string): Promise<number> {
  if (!existsSync(store)) return 0;
  const { Database } = await import("bun:sqlite");
  const db = new Database(store, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM sessions WHERE source_adapter = 'claude-hooks'").get() as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** The store the hook and `agentops check` use from `cwd`: AGENTOPS_DB resolved against the real directory, else the repository's shared store. */
/**
 * Every store the session can be in: the recorder's (where hooks import) and the
 * one `agentops check` would open from this directory, which differ when the
 * repository is not enrolled and a manual restore ran from a subdirectory.
 */
function forgetStores(cwd: string, env: NodeJS.ProcessEnv, mainRoot: string, stateDir: string): string[] {
  const here = realDirectory(cwd) ?? cwd;
  const recorder = recorderStore(cwd, env, mainRoot);
  const check = resolve(here, checkStorePath(here, env, stateDir));
  return [...new Set([recorder, check])];
}

/** The store `agentops check` opens from `cwd` (store.ts defaultStorePath, with this command's env and state dir). */
function checkStorePath(cwd: string, env: NodeJS.ProcessEnv, stateDir: string): string {
  if (env.AGENTOPS_DB !== undefined) return env.AGENTOPS_DB;
  const local = join(".agentops", "agentops.db");
  const enrolled = enrolledRepository(cwd, stateDir);
  if (enrolled) return join(enrolled, local);
  if (existsSync(resolve(cwd, local))) return local;
  const main = findRepositoryRoots(cwd)?.main;
  return main && existsSync(join(main, local)) ? join(main, local) : local;
}

function recorderStore(cwd: string, env: NodeJS.ProcessEnv, mainRoot: string): string {
  return env.AGENTOPS_DB !== undefined ? resolve(realDirectory(cwd) ?? cwd, env.AGENTOPS_DB) : join(mainRoot, ".agentops", "agentops.db");
}

/** The real path of a directory, or null when it cannot be resolved. */
function realDirectory(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
