import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStateDir, enrolledRepository } from "./enrollment";
import { appendHookPayload, writeRecorderError } from "./spool";

// `agentops hook <event>`: the Claude Code command-hook entry (spec R1.1-R1.4).
// Reads one hook payload from stdin, records it when the repository is
// enrolled, and always exits 0 with no output, so the agent is never blocked,
// slowed past the budget, or shown recorder text. Reached from src/main.ts
// without loading the rest of the CLI (spike S1 latency budget).

export type HookOutcome =
  | { recorded: true; seq: number }
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
  const result = appendHookPayload(join(stateDir, "spool"), payload, { storeRawPayload: storeRawPayload(repository) });
  if (result.ok) return { recorded: true, seq: result.seq };
  return { recorded: false, reason: "append-failed", detail: result.detail };
}

/** `privacy.storeRawPayload` from the repository's agentops.config.json; false when absent or unreadable. */
function storeRawPayload(repository: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(repository, "agentops.config.json"), "utf8"));
    return config?.privacy?.storeRawPayload === true;
  } catch {
    return false;
  }
}

/** Process entry: read stdin, handle, exit 0. Errors go to the session's errors file, never stdout/stderr. */
export async function runHookCommand(args: string[]): Promise<number> {
  let stdinText = "";
  try {
    stdinText = await Bun.stdin.text();
  } catch {
    // Unreadable stdin is treated as malformed input below.
  }
  try {
    const outcome = handleHook(args[0], stdinText);
    if (!outcome.recorded && outcome.reason === "malformed-input") {
      const sid = /"session_id"\s*:\s*"([^"]{1,128})"/.exec(stdinText)?.[1];
      if (sid) writeRecorderError(join(defaultStateDir(), "spool"), sid, "malformed-input", outcome.detail ?? "");
    }
  } catch {
    // Never surface recorder failures to the agent (R1.4).
  }
  return 0;
}
