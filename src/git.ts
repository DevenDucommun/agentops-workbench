import { execFileSync } from "node:child_process";

export type GitChange = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

export function getGitChanges(cwd = process.cwd()): GitChange[] {
  // NUL-delimited output keeps every path literal: no quoting, and no ambiguity with
  // names that contain " -> ", " => ", tabs, newlines or control characters.
  const statusOutput = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  const numstatOutput = git(["diff", "--numstat", "-z", "HEAD", "--"], cwd);
  return mergeGitChanges(parseGitStatusZ(statusOutput), parseGitNumstatZ(numstatOutput));
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
