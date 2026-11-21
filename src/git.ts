import { execFileSync } from "node:child_process";

export type GitChange = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

/** Thrown when `cwd` is not inside a Git work tree (or Git is not installed). */
export class NotAGitRepositoryError extends Error {}

/**
 * Changes in the working tree. With `base`, changes since the merge base of
 * `base` and HEAD, committed or not, so a clean PR checkout still reports the
 * branch's edits; without it, uncommitted work relative to HEAD (or the staged
 * files before the first commit). All Git output is read NUL-delimited, so every
 * path stays literal. Throws NotAGitRepositoryError outside a repository; any
 * other failure throws, so an unreadable diff is never reported as an empty one.
 */
export function getGitChanges(cwd = process.cwd(), options: { base?: string } = {}): GitChange[] {
  if (!isInsideWorkTree(cwd)) throw new NotAGitRepositoryError(`Not inside a git work tree: ${cwd}`);
  // NUL-delimited output keeps every path literal: no quoting, and no ambiguity with
  // names that contain " -> ", " => ", tabs, newlines or control characters.
  const statusOutput = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (!options.base) {
    // Before the first commit there is no HEAD: compare the work tree with the empty
    // tree, so staged and unstaged edits to tracked files both count.
    const head = hasHead(cwd) ? ["HEAD"] : [emptyTree(cwd)];
    const numstatOutput = git(["diff", "--numstat", "-z", ...head, "--"], cwd);
    return mergeGitChanges(parseGitStatusZ(statusOutput), parseGitNumstatZ(numstatOutput));
  }
  const mergeBase = git(["merge-base", options.base, "HEAD"], cwd).trim();
  const committed = parseGitNameStatusZ(git(["diff", "--name-status", "-z", "-M", mergeBase, "--"], cwd));
  const untracked = parseGitStatusZ(statusOutput).filter((change) => change.status === "??");
  const numstatOutput = git(["diff", "--numstat", "-z", "-M", mergeBase, "--"], cwd);
  return mergeGitChanges([...committed, ...untracked], parseGitNumstatZ(numstatOutput));
}

/** Git changes for a report, or none outside a repository. Other Git errors propagate. */
export function getGitChangesOrEmpty(cwd = process.cwd()): GitChange[] {
  try {
    return getGitChanges(cwd);
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) return [];
    throw error;
  }
}

/**
 * True inside a work tree. False outside a repository or when Git is not installed;
 * any other failure (an unreadable config or index, for example) throws, so a broken
 * repository is never reported as having no changes.
 */
function isInsideWorkTree(cwd: string): boolean {
  try {
    return gitRaw(["rev-parse", "--is-inside-work-tree"], cwd).trim() === "true";
  } catch (error) {
    const { code, stderr } = error as { code?: string; stderr?: string | Buffer };
    if (code === "ENOENT") return false;
    // Only Git's own diagnostic line counts, not the phrase inside another message.
    if (/^fatal: not a git repository\b/m.test(String(stderr ?? ""))) return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read git state: ${message}`);
  }
}

/** The empty tree's id in this repository's object format (SHA-1 or SHA-256). */
function emptyTree(cwd: string): string {
  return execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], { cwd, input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function hasHead(cwd: string): boolean {
  try {
    gitRaw(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
    return true;
  } catch {
    return false;
  }
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
    // Skip the original path. A rename or copy can sit in either column: ` R` comes from
    // `git add -N` on a renamed file.
    if (/[RC]/.test(status)) i++;
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
    return gitRaw(args, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read git state: ${message}`);
  }
}

// Large untracked trees (vendored SDKs, generated schemas) produce many megabytes of
// status output; the 1 MiB default would fail with ENOBUFS.
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

function gitRaw(args: string[], cwd: string): string {
  // core.quotePath=false keeps non-ASCII path bytes literal whatever the user's config.
  const output = execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    // English diagnostics, so "not a git repository" is recognized in any locale.
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return decodeGitOutput(output);
}

/**
 * A Git path for display. Bytes that were not valid UTF-8 (lone surrogates from
 * decodeGitOutput) are shown as \xNN and a literal backslash as \\, so every distinct
 * path prints distinctly. Valid characters, including astral ones such as emoji, are
 * left alone: the `u` flag matches only lone surrogates, never half of a valid pair.
 */
export function displayGitPath(path: string): string {
  return path.replace(/\\|[\uDC80-\uDCFF]/gu, (match) => (match === "\\" ? "\\\\" : `\\x${(match.charCodeAt(0) - 0xdc00).toString(16)}`));
}

/** True when the path holds bytes that were not valid UTF-8 (lone surrogates from decodeGitOutput). */
export function hasInvalidPathBytes(path: string): boolean {
  return /[\uDC80-\uDCFF]/u.test(path);
}

/** The original bytes of a decoded Git path, as lowercase hex. */
export function gitPathBytesHex(path: string): string {
  const bytes: number[] = [];
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xdc80 && code <= 0xdcff && char.length === 1) bytes.push(code - 0xdc00);
    else bytes.push(...Buffer.from(char, "utf8"));
  }
  return Buffer.from(bytes).toString("hex");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decodes Git output field by field (NUL-delimited), keeping a leading U+FEFF. A field
 * that is not valid UTF-8 (a path stored with Latin-1 bytes, say) maps each byte at or
 * above 0x80 to a lone surrogate (U+DC80-U+DCFF), as Python's "surrogateescape" does.
 * Valid UTF-8 never decodes to a lone surrogate, so two different byte paths can never
 * collapse into one name.
 */
export function decodeGitOutput(output: Buffer): string {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i <= output.length; i++) {
    if (i < output.length && output[i] !== 0) continue;
    const field = output.subarray(start, i);
    try {
      fields.push(strictUtf8.decode(field));
    } catch {
      fields.push([...field].map((byte) => String.fromCharCode(byte < 0x80 ? byte : 0xdc00 + byte)).join(""));
    }
    start = i + 1;
  }
  return fields.join("\0");
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
