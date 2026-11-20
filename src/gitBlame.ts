// Git blame and commit helpers for provenance (forensic recorder spec R3.1,
// R3.2; task T3.1). Parsers plus thin `git` wrappers that never throw: a
// missing repository, path or commit returns an empty result or null. Where Git
// defines the behavior (trailers, rename following, log order) it is delegated
// to git rather than reimplemented.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BlameLine = {
  /** Full commit SHA. All zeros for uncommitted lines. */
  sha: string;
  /** Line number in the commit that introduced it. */
  originalLine: number;
  /** Line number in the blamed revision. */
  finalLine: number;
  /** Path of the file in the commit that introduced the line (after renames). */
  originalPath: string;
  authorTime: number | null;
  summary: string | null;
  /** True for lines not yet committed (`git blame` reports the null SHA). */
  uncommitted: boolean;
  /** The line text, without the trailing newline. */
  content: string;
};

export type CommitInfo = {
  sha: string;
  parents: string[];
  authorTime: number;
  subject: string;
  /** `Key: value` trailers from the commit message body, in order. */
  trailers: Array<{ key: string; value: string }>;
  /**
   * Paths changed relative to the first parent (or added, for a root commit).
   * Null at a shallow-clone boundary, where the first parent was not fetched.
   */
  files: string[] | null;
};

const NULL_SHA = /^0{40}$|^0{64}$/;
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

/**
 * Parses `git blame --porcelain` output. Porcelain prints each commit's
 * metadata once, on its first line, so it is remembered and reused for the
 * commit's later lines.
 */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const commits = new Map<string, { authorTime: number | null; summary: string | null; filename: string | null }>();
  let current: { sha: string; originalLine: number; finalLine: number } | null = null;

  for (const raw of output.split("\n")) {
    if (current === null) {
      const header = SHA_HEADER.exec(raw);
      if (!header) continue;
      current = { sha: header[1] as string, originalLine: Number(header[2]), finalLine: Number(header[3]) };
      if (!commits.has(current.sha)) commits.set(current.sha, { authorTime: null, summary: null, filename: null });
      continue;
    }
    const meta = commits.get(current.sha) as { authorTime: number | null; summary: string | null; filename: string | null };
    if (raw.startsWith("\t")) {
      lines.push({
        sha: current.sha,
        originalLine: current.originalLine,
        finalLine: current.finalLine,
        originalPath: meta.filename ?? "",
        authorTime: meta.authorTime,
        summary: meta.summary,
        uncommitted: NULL_SHA.test(current.sha),
        content: raw.slice(1)
      });
      current = null;
      continue;
    }
    const space = raw.indexOf(" ");
    const key = space === -1 ? raw : raw.slice(0, space);
    const value = space === -1 ? "" : raw.slice(space + 1);
    if (key === "author-time") meta.authorTime = Number(value);
    else if (key === "summary") meta.summary = value;
    else if (key === "filename") meta.filename = unquoteGitPath(value);
  }
  return lines;
}

/**
 * `Key: value` trailers of a commit message, as Git itself finds them: the message
 * goes through `git interpret-trailers --parse --no-divider`, which reports what
 * `git log --format=%(trailers:only,unfold)` reports for the same message. Empty
 * when git is unavailable.
 */
export function parseTrailers(message: string): Array<{ key: string; value: string }> {
  const out = run(["git", "interpret-trailers", "--parse", "--no-divider"], new TextEncoder().encode(message));
  if (out === null) return [];
  const trailers: Array<{ key: string; value: string }> = [];
  for (const line of out.split("\n")) {
    // Git prints `key<separator> value`; a key is alphanumerics and dashes.
    const trailer = /^([A-Za-z0-9-]+)\S ?(.*)$/.exec(line);
    if (trailer) trailers.push({ key: trailer[1] as string, value: trailer[2] as string });
  }
  return trailers;
}

/**
 * Decodes a path that Git printed C-quoted ("caf\303\251", "a\tb"), including
 * octal-escaped UTF-8 bytes. Unquoted paths are returned unchanged.
 */
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const encoder = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      // Encode whole code points: an astral character spans two UTF-16 units.
      const point = String.fromCodePoint(body.codePointAt(i) as number);
      bytes.push(...encoder.encode(point));
      i += point.length - 1;
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else if (next in escapes) {
      bytes.push(escapes[next] as number);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  // ignoreBOM keeps a leading U+FEFF, which is part of the filename.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(bytes));
}

/**
 * Blames `path` at `rev` (default HEAD; `null` blames the working tree,
 * including uncommitted lines). `lines` limits the range, 1-based inclusive.
 */
export function blameFile(repo: string, path: string, options: { rev?: string | null; lines?: [number, number] } = {}): BlameLine[] {
  const args = ["blame", "--porcelain"];
  if (options.lines) args.push("-L", `${options.lines[0]},${options.lines[1]}`);
  const rev = options.rev === undefined ? "HEAD" : options.rev;
  if (rev !== null) args.push(rev);
  args.push("--", path);
  const out = git(repo, args);
  return out === null ? [] : parseBlamePorcelain(out);
}

/**
 * Commit metadata, trailers and changed paths, or null when git cannot resolve
 * `rev`. `parents` are the commit object's real parents, even at a shallow-clone
 * boundary where Git hides them. `files` is null when the first parent is not in
 * the repository (a shallow boundary), because the change cannot be computed.
 */
export function getCommitInfo(repo: string, rev: string): CommitInfo | null {
  // NUL cannot occur in a commit message, so it is the only safe field delimiter.
  // Trailers come from Git's own parser, as alternating key and value fields.
  const format = "%H%x00%at%x00%s%x00%(trailers:only,unfold,separator=%x00,key_value_separator=%x00)";
  const header = git(repo, ["show", "-s", "--encoding=UTF-8", `--format=${format}`, `${rev}^{commit}`]);
  if (header === null) return null;
  const [sha, authorTime, subject, ...trailerFields] = header.replace(/\n$/, "").split("\0");
  if (!sha || !SHA.test(sha)) return null;
  const trailers: Array<{ key: string; value: string }> = [];
  for (let i = 0; i + 1 < trailerFields.length; i += 2) trailers.push({ key: trailerFields[i] as string, value: trailerFields[i + 1] as string });
  // %P omits parents cut off by a shallow clone; the raw object always lists them.
  const raw = git(repo, ["cat-file", "commit", sha]);
  if (raw === null) return null;
  const parentShas: string[] = [];
  for (const line of raw.slice(0, raw.indexOf("\n\n") >>> 0).split("\n")) {
    if (line.startsWith("parent ")) parentShas.push(line.slice(7));
  }
  // Without an explicit base, diff-tree prints nothing for a merge commit, so
  // compare against the first parent; a root commit lists everything it adds.
  const first = parentShas[0];
  const files = git(repo, first ? ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", first, sha] : ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha]);
  return {
    sha,
    parents: parentShas,
    authorTime: Number(authorTime),
    subject: subject ?? "",
    trailers,
    files: files === null ? (first ? null : []) : files.split("\0").filter(Boolean)
  };
}

/**
 * Full SHAs of the commits in the lineage of the file now at `path` in HEAD,
 * newest first in Git's `--date-order` (a merge before its parents, otherwise by
 * commit time). `path` is literal, never a pattern. `limit: 0` returns no commits.
 *
 * A commit is listed when it changed the file relative to every parent, as
 * `git log -c` shows it: an ordinary edit, the commit that added or renamed it,
 * or a merge whose result matches no parent (a conflict resolution, or a clean
 * merge of a rename with an edit). Where the file is absent from a parent, Git's
 * rename detection between that parent and the commit decides whether it came
 * from another path; if so the history continues under that path on that side.
 *
 * Lineage rule: history stops where the file was created. A commit that adds the
 * path relative to every parent, without a rename source, is the file's first
 * commit, so a path that was deleted and later recreated starts fresh, and a
 * file renamed onto a reused name does not inherit the deleted file's commits.
 *
 * In a shallow clone a boundary commit (whose parents were not fetched) is never
 * listed: Git would report it as adding every file, and what it really changed
 * cannot be computed.
 */
export function commitsTouching(repo: string, path: string, options: { limit?: number } = {}): string[] {
  const { limit } = options;
  if (limit !== undefined && limit <= 0) return [];
  const shallow = shallowBoundary(repo);
  if (shallow === null) return [];
  const found = new Set<string>();
  const queue: Array<{ path: string; tip: string }> = [{ path, tip: "HEAD" }];
  const seen = new Set<string>();
  let segments = 0;
  while (queue.length > 0) {
    const segment = queue.shift() as { path: string; tip: string };
    const key = `${segment.tip}\0${segment.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    segments++;
    const commits = pathSegment(repo, segment.path, segment.tip, limit, shallow, queue);
    if (commits === null) return [];
    for (const sha of commits) found.add(sha);
  }
  if (segments === 1 || found.size <= 1) return [...found].slice(0, limit);
  // Several segments: put the union back into Git's date order for the whole graph.
  const order = git(repo, ["rev-list", "--date-order", "HEAD"]);
  if (order === null) return [];
  const sorted = order.split("\n").filter((sha) => found.has(sha));
  return sorted.slice(0, limit);
}

/**
 * The commits on `path` reachable from `tip`, as `git log -c` lists them, cut at
 * the file's creation. Queues the rename sources it finds as further segments.
 */
function pathSegment(
  repo: string,
  path: string,
  tip: string,
  limit: number | undefined,
  shallow: Set<string>,
  queue: Array<{ path: string; tip: string }>
): string[] | null {
  const excluded = new Set<string>();
  const examined = new Set<string>();
  // A creation found on one pass hides everything behind it on the next; at most a
  // few passes, since each one adds exclusions only for creations it newly found.
  for (;;) {
    const entries = logPath(repo, path, tip, [...excluded], limit);
    if (entries === null) return null;
    const commits: string[] = [];
    let added = false;
    for (const { sha, status } of entries) {
      if (shallow.has(sha)) continue;
      commits.push(sha);
      if (examined.has(sha) || !status.includes("A")) continue;
      examined.add(sha);
      const parents = realParents(repo, sha);
      if (parents === null) return null;
      for (let i = 0; i < parents.length; i++) {
        if (status[i] !== "A") continue;
        const source = renameSource(repo, parents[i] as string, sha, path);
        if (source !== null) queue.push({ path: source, tip: parents[i] as string });
      }
      // Absent from every parent: under this name the file starts here.
      if (status.length === Math.max(parents.length, 1) && [...status].every((s) => s === "A")) {
        for (const parent of parents) {
          if (!excluded.has(parent)) {
            excluded.add(parent);
            added = true;
          }
        }
      }
    }
    if (!added) return commits;
  }
}

/** One `git log -c` over a literal path: each listed commit and its per-parent status letters. */
function logPath(repo: string, path: string, tip: string, excluded: string[], limit: number | undefined): Array<{ sha: string; status: string }> | null {
  const args = ["log", "--date-order", "--root", "--no-renames", "-c", "--name-status", "--format=%x01%H"];
  if (limit !== undefined) args.push(`-n${limit}`);
  const out = git(repo, [...args, tip, ...excluded.map((sha) => `^${sha}`), "--", path]);
  if (out === null) return null;
  const entries: Array<{ sha: string; status: string }> = [];
  let current: string | null = null;
  // Without -z, Git C-quotes paths with control characters, so only a header starts with \x01.
  for (const line of out.split("\n")) {
    if (line.startsWith("\u0001")) {
      const sha = line.slice(1);
      current = SHA.test(sha) ? sha : null;
    } else if (line !== "" && current !== null) {
      entries.push({ sha: current, status: line.slice(0, line.indexOf("\t") >>> 0) });
      current = null;
    }
  }
  return entries;
}

/** The path `path` in `commit` was renamed from in `parent`, by Git's rename detection. */
function renameSource(repo: string, parent: string, commit: string, path: string): string | null {
  const out = git(repo, ["diff-tree", "-r", "-M", "--diff-filter=R", "--name-status", "-z", parent, commit]);
  if (out === null) return null;
  const fields = out.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === path) return fields[i + 1] as string;
  }
  return null;
}

/** Parents as Git walks them (none at a shallow boundary). */
function realParents(repo: string, sha: string): string[] | null {
  const out = git(repo, ["rev-list", "--no-walk", "--parents", sha]);
  return out === null ? null : out.trim().split(" ").slice(1);
}

/** Commits at a shallow clone's boundary, whose parents are missing; empty when not shallow. */
function shallowBoundary(repo: string): Set<string> | null {
  const out = git(repo, ["rev-parse", "--is-shallow-repository", "--git-path", "shallow"]);
  if (out === null) return null;
  const [isShallow, file] = out.split("\n");
  if (isShallow !== "true" || !file) return new Set();
  try {
    const text = readFileSync(resolve(repo, file), "utf8");
    return new Set(text.split("\n").filter((line) => SHA.test(line)));
  } catch {
    return new Set();
  }
}

/**
 * Runs git with literal pathspecs, pinning the settings that would change the
 * output these parsers read: UTF-8 log output, root commits shown, no implicit
 * --follow, no signature blocks, no color. Null when git exits nonzero or cannot
 * be started.
 */
function git(repo: string, args: string[]): string | null {
  return run(["git", "--literal-pathspecs", ...PINNED_CONFIG, "-C", repo, ...args]);
}

const PINNED_CONFIG = [
  "-c",
  "i18n.logOutputEncoding=UTF-8",
  "-c",
  "log.showRoot=true",
  "-c",
  "log.follow=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "color.ui=false"
];

function run(argv: string[], stdin?: Uint8Array): string | null {
  try {
    const proc = Bun.spawnSync(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "ignore" });
    return proc.exitCode === 0 ? proc.stdout.toString() : null;
  } catch {
    return null;
  }
}
