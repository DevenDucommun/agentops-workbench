import { readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { defaultStateDir, enrolledRepository } from "./enrollment";
import { appendHookPayload, writeRecorderError } from "./spool";

// `agentops hook <event>`: the Claude Code command-hook entry (spec R1.1-R1.4).
// Reads one hook payload from stdin, records it when the repository is
// enrolled, and always exits 0, so the agent is never blocked or slowed past
// the budget. It prints nothing, except the opt-in turn-end verdict (T1.6).
// Reached from src/main.ts without loading the rest of the CLI (spike S1
// latency budget).

export type HookOutcome =
  | { recorded: true; seq: number; repository: string; spoolFile: string; hookEventName: string }
  | { recorded: false; reason: "malformed-input" | "not-enrolled" | "append-failed"; detail?: string };

export type HookOptions = { stateDir?: string; env?: NodeJS.ProcessEnv };

/** Processes one hook payload. Pure enough to test without a process; never throws. */
export function handleHook(eventArg: string | undefined, stdinText: string, options: HookOptions = {}): HookOutcome {
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? defaultStateDir(env);
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdinText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("payload is not an object");
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    return { recorded: false, reason: "malformed-input", detail: error instanceof Error ? error.message : String(error) };
  }

  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const repository = enrolledRepository(cwd, stateDir);
  if (!repository) return { recorded: false, reason: "not-enrolled" };

  if (typeof payload.hook_event_name !== "string" && eventArg) payload.hook_event_name = eventArg;
  const result = appendHookPayload(join(stateDir, "spool"), payload, {
    storeRawPayload: storeRawPayload(repository),
    repoRoots: repositoryRoots(repository, cwd)
  });
  if (result.ok) return { recorded: true, seq: result.seq, repository, spoolFile: result.path, hookEventName: String(payload.hook_event_name ?? "") };
  return { recorded: false, reason: "append-failed", detail: result.detail };
}

/** The enrolled root plus the same root as the agent spelled it (it may differ by symlinks, e.g. /tmp vs /private/tmp). */
function repositoryRoots(repository: string, cwd: string): string[] {
  try {
    const rel = relative(repository, realpathSync(cwd));
    if (rel === "") return cwd === repository ? [repository] : [repository, cwd];
    if (!rel.startsWith("..") && cwd.endsWith(`${sep}${rel}`)) return [repository, cwd.slice(0, -(rel.length + 1))];
  } catch {
    // Fall back to the real root only.
  }
  return [repository];
}

/** Session-end ingest (R1.6): spool -> store -> analyzer, in the enrolled repository's store. Never throws. */
export async function ingestAfterSessionEnd(outcome: HookOutcome, stateDir: string): Promise<void> {
  if (!outcome.recorded || outcome.hookEventName !== "SessionEnd") return;
  try {
    const { ingestSpoolFile } = await import("./ingest");
    ingestSpoolFile(outcome.spoolFile, { repoRoot: outcome.repository });
  } catch (error) {
    const sid = basename(outcome.spoolFile).replace(/\.jsonl$/, "");
    writeRecorderError(join(stateDir, "spool"), sid, "ingest-failed", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Optional turn-end verdict (spec R1.6, T1.6): with `recorder.verdict: true` in
 * agentops.config.json, a recorded Stop returns the Stop hook's JSON output, a
 * `systemMessage` shown to the user. It never sets `decision`, so it never
 * blocks the stop. Off by default; any failure returns null (no output).
 */
export async function verdictAfterStop(outcome: HookOutcome, stateDir: string): Promise<string | null> {
  if (!outcome.recorded || outcome.hookEventName !== "Stop" || repoConfigFlag(outcome.repository, "recorder", "verdict") !== true) return null;
  try {
    const { turnVerdict } = await import("./ingest");
    return JSON.stringify({ systemMessage: turnVerdict(outcome.spoolFile, { repoRoot: outcome.repository }) });
  } catch (error) {
    const sid = basename(outcome.spoolFile).replace(/\.jsonl$/, "");
    writeRecorderError(join(stateDir, "spool"), sid, "verdict-failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** `privacy.storeRawPayload` from the repository's agentops.config.json; false when absent or unreadable. */
function storeRawPayload(repository: string): boolean {
  return repoConfigFlag(repository, "privacy", "storeRawPayload") === true;
}

function repoConfigFlag(repository: string, section: string, key: string): unknown {
  try {
    const config = JSON.parse(readFileSync(join(repository, "agentops.config.json"), "utf8"));
    return config?.[section]?.[key];
  } catch {
    return undefined;
  }
}

/**
 * Process entry: read stdin, handle, exit 0. Errors go to the session's errors
 * file. The only stdout is the opt-in Stop verdict JSON; stderr is never used.
 */
export async function runHookCommand(args: string[]): Promise<number> {
  let stdinText = "";
  try {
    stdinText = await Bun.stdin.text();
  } catch {
    // Unreadable stdin is treated as malformed input below.
  }
  try {
    const outcome = handleHook(args[0], stdinText);
    await ingestAfterSessionEnd(outcome, defaultStateDir());
    const verdict = await verdictAfterStop(outcome, defaultStateDir());
    if (verdict) process.stdout.write(`${verdict}\n`);
    if (!outcome.recorded && outcome.reason === "malformed-input") {
      const sid = /"session_id"\s*:\s*"([^"]{1,128})"/.exec(stdinText)?.[1];
      if (sid) writeRecorderError(join(defaultStateDir(), "spool"), sid, "malformed-input", outcome.detail ?? "");
    }
  } catch {
    // Never surface recorder failures to the agent (R1.4).
  }
  return 0;
}
