import { execFileSync } from "node:child_process";

export type GitChange = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

/**
 * Changes in the working tree. With `base`, changes since the merge base of
 * `base` and HEAD, committed or not, so a clean PR checkout still reports the
 * branch's edits; without it, only uncommitted work relative to HEAD. All Git
 * output is read NUL-delimited, so every path stays literal: no quoting, and no
 * ambiguity with names that contain " -> ", " => ", tabs or control characters.
 */
export function getGitChanges(cwd = process.cwd(), options: { base?: string } = {}): GitChange[] {
  const statusOutput = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (!options.base) {
    const numstatOutput = git(["diff", "--numstat", "-z", "HEAD", "--"], cwd);
    return mergeGitChanges(parseGitStatusZ(statusOutput), parseGitNumstatZ(numstatOutput));
  }
  const mergeBase = git(["merge-base", options.base, "HEAD"], cwd).trim();
  const committed = parseGitNameStatusZ(git(["diff", "--name-status", "-z", "-M", mergeBase, "--"], cwd));
  const untracked = parseGitStatusZ(statusOutput).filter((change) => change.status === "??");
  const numstatOutput = git(["diff", "--numstat", "-z", "-M", mergeBase, "--"], cwd);
  return mergeGitChanges([...committed, ...untracked], parseGitNumstatZ(numstatOutput));
}

/** `git diff --name-status` output; a rename or copy reports its new path. */
export function parseGitNameStatus(input: string): GitChange[] {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status = "", ...paths] = line.split("\t");
      return { path: unquoteGitPath(paths.at(-1) ?? ""), status: status.charAt(0) || "M", additions: null, deletions: null };
    })
    .filter((change) => change.path.length > 0);
}

/** Parses `git diff --name-status -z`: `S\0path\0`, or `R087\0orig\0new\0` for a rename or copy. */
export function parseGitNameStatusZ(input: string): GitChange[] {
  const fields = input.split("\0");
  const changes: GitChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i] as string;
    if (!/^[A-Z][0-9]*$/.test(status)) continue;
    if (status[0] === "R" || status[0] === "C") i++; // skip the original path
    const path = fields[++i] ?? "";
    if (path) changes.push({ path, status: status.charAt(0), additions: null, deletions: null });
  }
  return changes;
}

/** Parses `git status --porcelain=v1 -z`: `XY path\0`, with `orig\0` after a rename or copy. */
export function parseGitStatusZ(input: string): GitChange[] {
  const fields = input.split("\0");
  const changes: GitChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    changes.push({ path: field.slice(3), status: status.trim() || "modified", additions: null, deletions: null });
    if (status[0] === "R" || status[0] === "C") i++; // skip the original path
  }
  return changes;
}

/** Parses `git diff --numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0orig\0new\0` for a rename. */
export function parseGitNumstatZ(input: string): Array<Pick<GitChange, "path" | "additions" | "deletions">> {
  const fields = input.split("\0");
  const stats: Array<Pick<GitChange, "path" | "additions" | "deletions">> = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/.exec(fields[i] as string);
    if (!match) continue;
    let path = match[3] as string;
    if (path === "") {
      i += 2; // rename: original, then new path
      path = fields[i] ?? "";
    }
    if (path) stats.push({ path, additions: parseNumstatCount(match[1]), deletions: parseNumstatCount(match[2]) });
  }
  return stats;
}

export function parseGitStatus(input: string): GitChange[] {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const path = normalizeStatusPath(rawPath);
      return {
        path,
        status: status.trim() || "modified",
        additions: null,
        deletions: null
      };
    });
}

export function parseGitNumstat(input: string): Array<Pick<GitChange, "path" | "additions" | "deletions">> {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [added, deleted, ...pathParts] = line.split(/\t/);
      return {
        path: normalizeNumstatPath(pathParts.join("\t")),
        additions: parseNumstatCount(added),
        deletions: parseNumstatCount(deleted)
      };
    });
}

export function mergeGitChanges(
  statuses: GitChange[],
  numstats: Array<Pick<GitChange, "path" | "additions" | "deletions">>
): GitChange[] {
  const byPath = new Map<string, GitChange>();
  for (const status of statuses) {
    byPath.set(status.path, status);
  }
  for (const stat of numstats) {
    const current = byPath.get(stat.path);
    if (current) {
      current.additions = stat.additions;
      current.deletions = stat.deletions;
    } else {
      byPath.set(stat.path, {
        path: stat.path,
        status: "modified",
        additions: stat.additions,
        deletions: stat.deletions
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function git(args: string[], cwd: string): string {
  try {
    // core.quotePath=false keeps non-ASCII path bytes literal whatever the user's config.
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read git state: ${message}`);
  }
}

function parseNumstatCount(value: string | undefined): number | null {
  if (!value || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatusPath(path: string): string {
  const renameArrow = " -> ";
  if (path.includes(renameArrow)) {
    return path.slice(path.indexOf(renameArrow) + renameArrow.length);
  }
  return unquoteGitPath(path);
}

function normalizeNumstatPath(path: string): string {
  const braceRename = /\{.* => (.*)\}/.exec(path);
  if (braceRename?.[1]) return path.replace(/\{.* => .*}/, braceRename[1]);
  if (path.includes(" => ")) {
    return path.slice(path.lastIndexOf(" => ") + 4);
  }
  return unquoteGitPath(path);
}

function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}
