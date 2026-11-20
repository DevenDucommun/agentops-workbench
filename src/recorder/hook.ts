import { readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { defaultStateDir, enrolledRoots } from "./enrollment";
import { appendHookPayload, writeRecorderError } from "./spool";

// `agentops hook <event>`: the Claude Code command-hook entry (spec R1.1-R1.4).
// Reads one hook payload from stdin, records it when the repository is
// enrolled, and always exits 0 with no output, so the agent is never blocked,
// slowed past the budget, or shown recorder text. Reached from src/main.ts
// without loading the rest of the CLI (spike S1 latency budget).

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
  const roots = enrolledRoots(cwd, stateDir);
  if (!roots) return { recorded: false, reason: "not-enrolled" };

  const repository = roots.main;
  if (typeof payload.hook_event_name !== "string" && eventArg) payload.hook_event_name = eventArg;
  const result = appendHookPayload(join(stateDir, "spool"), payload, {
    storeRawPayload: storeRawPayload(repository),
    repoRoots: repositoryRoots(roots.checkout, cwd),
    gitCommit: observedPush(payload, cwd)
  });
  if (result.ok) return { recorded: true, seq: result.seq, repository, spoolFile: result.path, hookEventName: String(payload.hook_event_name ?? "") };
  return { recorded: false, reason: "append-failed", detail: result.detail };
}

/**
 * The commit a successful `git push` sent, resolved in the checkout at hook time.
 * The reported shell command is parsed, never executed.
 */
function observedPush(payload: Record<string, unknown>, cwd: string): { sha: string; kind: string } | undefined {
  if (payload.hook_event_name !== "PostToolUse" || payload.tool_name !== "Bash") return;
  const input = payload.tool_input as { command?: unknown } | undefined;
  const response = payload.tool_response as { stdout?: unknown; stderr?: unknown; interrupted?: boolean; exitCode?: number; exit_code?: number } | undefined;
  if (!response || response.interrupted || (response.exitCode ?? response.exit_code ?? 0) !== 0 || payload.error) return;
  if (typeof input?.command !== "string") return;
  if (!input.command.includes("push")) return;
  const output = [response.stdout, response.stderr].filter((v) => typeof v === "string").join("\n");
  const source = pushSource(input.command, output);
  if (!source) return;
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--verify", "--quiet", "--end-of-options", `${source}^{commit}`], { stdout: "pipe", stderr: "ignore" });
    const sha = result.stdout.toString().trim();
    if (result.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return { sha, kind: "pushed" };
  } catch {
    // A missing Git executable leaves the tool event available without a commit link.
  }
}

// Push options that take a separate value, and pushes that send no single commit.
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const PUSH_NO_COMMIT = new Set(["--dry-run", "--all", "--branches", "--mirror", "--tags", "--delete", "--prune", "--help"]);

/**
 * The local revision a push command sends, or undefined when it cannot be known
 * from the command alone. Accepts `git push` as the last step of an `&&` chain with
 * no directory change; with no refspec Git’s output identifies the configured source, with one refspec
 * its source side is. Dry runs, deletions, several refspecs and anything with
 * quoting or other shell syntax give no link.
 */
export function pushSource(command: string, output = ""): string | undefined {
  const segments = command.split("&&").map((part) => part.trim());
  if (segments.some((part) => !part || /[;&|`$<>\n"'\\()]/.test(part))) return;
  if (segments.slice(0, -1).some((part) => /^(?:cd|pushd|popd)(?:\s|$)/.test(part))) return;
  const tokens = (segments.at(-1) ?? "").split(/\s+/);
  if (tokens[0] !== "git" || tokens[1] !== "push") return;
  const positionals: string[] = [];
  let remoteInOption = false;
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === "--repo" || token.startsWith("--repo=")) remoteInOption = true;
    if (PUSH_VALUE_OPTIONS.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("--")) {
      if (PUSH_NO_COMMIT.has(token.split("=")[0] as string)) return;
      continue;
    }
    if (token.startsWith("-")) {
      if (/[nd]/.test(token.slice(1))) return; // -n (dry run) or -d (delete), alone or grouped
      continue;
    }
    positionals.push(token);
  }
  const refspecs = remoteInOption ? positionals : positionals.slice(1);
  if (refspecs.length === 0) {
    const updates = output.split(/\r?\n/).filter((line) => line.includes(" -> "));
    const sources = updates.map((line) => /\s([A-Za-z0-9_][A-Za-z0-9_./-]*) -> \S+\s*$/.exec(line)?.[1]);
    return sources.length && sources.every((source) => source && source === sources[0]) ? sources[0] : undefined;
  }
  if (refspecs.length > 1) return;
  const src = (refspecs[0] as string).replace(/^\+/, "").split(":")[0] ?? "";
  return src && !src.startsWith("-") ? src : undefined;
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
    await ingestAfterSessionEnd(outcome, defaultStateDir());
    if (!outcome.recorded && outcome.reason === "malformed-input") {
      const sid = /"session_id"\s*:\s*"([^"]{1,128})"/.exec(stdinText)?.[1];
      if (sid) writeRecorderError(join(defaultStateDir(), "spool"), sid, "malformed-input", outcome.detail ?? "");
    }
  } catch {
    // Never surface recorder failures to the agent (R1.4).
  }
  return 0;
}
