import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultStateDir, enrolledRepository, enrollRepository, findRepositoryRoots, unenrollRepository } from "./enrollment";

// `agentops recorder enable|disable|status` (spec R1.7). Dispatched from
// src/main.ts like `hook`, so it works in the release binary and `bun run
// agentops`. Enrollment is per repository and lives in the user state dir.

export const PLUGIN_INSTALL = "/plugin install agentops-recorder --marketplace DevenDucommun/agentops-workbench";

export type CommandResult = { stdout: string; stderr?: string; exitCode: number };
export type RecorderCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

const USAGE = "Usage: agentops recorder enable|disable|status\n";

export async function runRecorderCommand(args: string[], options: RecorderCommandOptions = {}): Promise<CommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stateDir = defaultStateDir(env);
  const roots = findRepositoryRoots(cwd);
  const [sub] = args;

  if (sub !== "enable" && sub !== "disable" && sub !== "status") return { stdout: "", stderr: USAGE, exitCode: 1 };
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
