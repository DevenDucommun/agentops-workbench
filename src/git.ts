import { execFileSync } from "node:child_process";

export type GitChange = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

export function getGitChanges(cwd = process.cwd()): GitChange[] {
  const statusOutput = git(["status", "--porcelain=v1"], cwd);
  const numstatOutput = git(["diff", "--numstat", "HEAD", "--"], cwd);
  return mergeGitChanges(parseGitStatus(statusOutput), parseGitNumstat(numstatOutput));
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
    return execFileSync("git", args, {
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
