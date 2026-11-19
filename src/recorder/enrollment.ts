import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Per-repository opt-in for the forensic recorder (spec R1.7). Enrollment
// lives in the user state directory, never in the checkout, so it cannot be
// committed. A repository is identified by the real path of its main checkout;
// linked worktrees of an enrolled repository are enrolled too. Only fs calls:
// this runs on every hook, inside the latency budget (spike S1).

const REGISTRY_SCHEMA = "agentops.recorder-enrollment.v1";

/** `$AGENTOPS_STATE_DIR`, else `$XDG_STATE_HOME/agentops`, else `~/.local/state/agentops`. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTOPS_STATE_DIR || (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "agentops") : join(homedir(), ".local", "state", "agentops"));
}

export function registryPath(stateDir: string): string {
  return join(stateDir, "recorder", "enrolled.json");
}

export type RepositoryRoots = { checkout: string; main: string };

/**
 * Walks up from `cwd` to the nearest `.git` entry. Returns the checkout root
 * and the main checkout root (they differ for a linked worktree, whose `.git`
 * is a file pointing at `<main>/.git/worktrees/<name>`). Null outside a repo.
 */
export function findRepositoryRoots(cwd: string): RepositoryRoots | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return null;
  }
  for (;;) {
    const dotGit = join(dir, ".git");
    let kind: "dir" | "file" | null = null;
    try {
      const st = statSync(dotGit);
      kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
    } catch {
      kind = null;
    }
    if (kind === "dir") return { checkout: dir, main: dir };
    if (kind === "file") return { checkout: dir, main: mainCheckoutFromGitFile(dir, dotGit) ?? dir };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function mainCheckoutFromGitFile(checkout: string, dotGitFile: string): string | null {
  try {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGitFile, "utf8"));
    if (!match) return null;
    const gitDir = resolve(checkout, match[1].trim());
    const commonFile = join(gitDir, "commondir");
    const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    return realpathSync(dirname(commonDir));
  } catch {
    return null;
  }
}

function readRegistry(stateDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(stateDir), "utf8"));
    if (parsed?.schemaVersion !== REGISTRY_SCHEMA || !Array.isArray(parsed.repositories)) return [];
    return parsed.repositories.filter((r: unknown): r is string => typeof r === "string" && isAbsolute(r));
  } catch {
    return [];
  }
}

function writeRegistry(stateDir: string, repositories: string[]): void {
  const path = registryPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA, repositories: [...new Set(repositories)].sort() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The enrolled main-checkout root for `cwd`, or null when it is not enrolled (or not a repo). */
export function enrolledRepository(cwd: string, stateDir: string): string | null {
  const roots = findRepositoryRoots(cwd);
  if (!roots) return null;
  const enrolled = readRegistry(stateDir);
  return enrolled.includes(roots.main) ? roots.main : null;
}

/** Enrolls the repository containing `cwd`. Returns its main-checkout root. */
export function enrollRepository(cwd: string, stateDir: string): string {
  const roots = findRepositoryRoots(cwd);
  if (!roots) throw new Error(`not inside a git repository: ${cwd}`);
  writeRegistry(stateDir, [...readRegistry(stateDir), roots.main]);
  return roots.main;
}

/** Removes the repository containing `cwd`. Returns whether it was enrolled. */
export function unenrollRepository(cwd: string, stateDir: string): boolean {
  const roots = findRepositoryRoots(cwd);
  if (!roots) return false;
  const enrolled = readRegistry(stateDir);
  if (!enrolled.includes(roots.main)) return false;
  writeRegistry(stateDir, enrolled.filter((r) => r !== roots.main));
  return true;
}
