// Git blame and commit helpers for provenance (forensic recorder spec R3.1,
// R3.2; task T3.1). Parsers plus thin `git` wrappers that never throw: a
// missing repository, path or commit returns an empty result or null. Where Git
// defines the behavior (trailers, rename following, log order) it is delegated
// to git rather than reimplemented.

import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

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
    // Git prints `key<separator> value`; a key is alphanumerics and dashes. Only \n
    // ends a line: the value may hold U+2028 and other characters `.` would skip.
    const trailer = /^([A-Za-z0-9-]+)\S ?([^\n]*)$/.exec(line);
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
  const parentShas = rawParents(repo, sha);
  if (parentShas === null) return null;
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
 * newest first in Git's `--date-order` over the whole commit graph (a merge
 * before its parents, otherwise by commit time). `limit: 0` returns no commits.
 *
 * `path` is literal, never a pattern. It is read relative to `repo` the way Git
 * reads a path argument, so `./a`, `a//b` and, from a subdirectory, `../x` name
 * the same file as their normalized spelling; a path outside the work tree has
 * no history. A path with no file at HEAD (never created, or deleted) has none.
 *
 * The walk starts at HEAD and tracks the file's path in each commit. A commit is
 * listed when its file differs (content or mode) from the file in every parent:
 * an ordinary edit, the commit that added or renamed it, or a merge that matches
 * no parent (a conflict resolution, or a clean merge of a rename with an edit).
 * A commit whose file matches a parent is not listed, and the walk follows only
 * the first such parent, as `git log -- <path>` simplifies history. Otherwise
 * every parent that has the file is followed under the same path; for a parent
 * without it, Git's rename detection between that parent and the commit decides
 * whether the file came from another path, which that side then follows.
 *
 * Lineage rule: history stops where the file was created. On each side the walk
 * ends at a parent that lacks the file and is no rename source, so a deleted and
 * recreated path starts fresh, a rename onto a reused name does not inherit the
 * deleted file's commits, and a merge still reaches the ancestors of a parent
 * that kept the file.
 *
 * In a shallow clone a boundary commit (whose parents were not fetched) is not
 * listed and ends the walk, because what it changed cannot be computed. It is
 * listed only when its commit object has no parents, that is a real root.
 */
export function commitsTouching(repo: string, path: string, options: { limit?: number } = {}): string[] {
  const { limit } = options;
  if (limit !== undefined && limit <= 0) return [];
  const target = treePath(repo, path);
  if (target === null) return [];
  const graph = git(repo, ["rev-list", "--date-order", "--parents", "HEAD"]);
  const shallow = shallowBoundary(repo);
  if (graph === null || shallow === null) return [];
  const order: string[] = [];
  const parents = new Map<string, string[]>();
  for (const line of graph.split("\n")) {
    if (line === "") continue;
    const [sha, ...rest] = line.split(" ");
    order.push(sha as string);
    parents.set(sha as string, rest);
  }
  const files = new FileLookup(repo, order);
  const head = order[0];
  if (head === undefined || files.at(head, target) === null) return [];
  // Path of the file in each commit still to visit. --date-order puts every
  // commit after all of its children, so a commit's path is final when reached.
  const pending = new Map<string, string>([[head, target]]);
  const follow = (sha: string, file: string) => {
    if (!pending.has(sha)) pending.set(sha, file);
  };
  const touching: string[] = [];
  for (const sha of order) {
    const file = pending.get(sha);
    if (file === undefined) continue;
    pending.delete(sha);
    const mine = files.at(sha, file);
    if (mine === null) continue;
    const ups = parents.get(sha) ?? [];
    if (ups.length === 0) {
      // A root adds the file; a shallow boundary's change is unknown.
      if (!shallow.has(sha) || rawParents(repo, sha)?.length === 0) touching.push(sha);
    } else {
      const theirs = ups.map((up) => files.at(up, file));
      const same = theirs.indexOf(mine);
      if (same !== -1) {
        follow(ups[same] as string, file);
        continue;
      }
      touching.push(sha);
      for (let i = 0; i < ups.length; i++) {
        const up = ups[i] as string;
        if (theirs[i] !== null) {
          follow(up, file);
          continue;
        }
        const source = renameSource(repo, up, sha, file);
        if (source !== null) follow(up, source);
      }
    }
    if (limit !== undefined && touching.length >= limit) break;
  }
  return touching;
}

/**
 * The mode and object id of a path in many commits, read in batches through one
 * `git cat-file --batch-check` per batch, in the walk's commit order.
 */
class FileLookup {
  private readonly index = new Map<string, number>();
  private readonly cache = new Map<string, Array<string | null>>();

  constructor(
    private readonly repo: string,
    private readonly order: string[]
  ) {
    for (let i = 0; i < order.length; i++) this.index.set(order[i] as string, i);
  }

  /** `mode oid` of `path` in `sha`, or null when it is absent or not a file. */
  at(sha: string, path: string): string | null {
    const position = this.index.get(sha);
    if (position === undefined) return null;
    let known = this.cache.get(path);
    if (known === undefined) {
      known = [];
      this.cache.set(path, known);
    }
    while (known.length <= position) {
      const batch = this.order.slice(known.length, known.length + Math.max(256, known.length));
      const input = new TextEncoder().encode(batch.map((commit) => `${commit}:${path}\0`).join(""));
      const out = git(this.repo, ["cat-file", "--batch-check=%(objecttype) %(objectmode) %(objectname)", "-Z"], input);
      // A failed batch means "absent" for every commit in it, never an exception.
      const records = out === null ? [] : out.split("\0");
      for (let i = 0; i < batch.length; i++) {
        const [type, mode, oid] = (records[i] ?? "").split(" ");
        known.push(type !== undefined && type !== "tree" && oid !== undefined && SHA.test(oid) ? `${mode} ${oid}` : null);
      }
    }
    return known[position] ?? null;
  }
}

/**
 * `path` as a path from the top of the work tree, read relative to `repo` as Git
 * reads a path argument. Null when it leaves the work tree or names its top.
 */
function treePath(repo: string, path: string): string | null {
  const prefix = git(repo, ["rev-parse", "--show-prefix"]);
  if (prefix === null || path === "" || path.startsWith("/")) return null;
  const joined = posix.normalize(prefix.replace(/\n$/, "") + path);
  if (joined === "." || joined === ".." || joined.startsWith("../") || joined.endsWith("/")) return null;
  return joined;
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

/** Parents recorded in the commit object itself, including any a shallow clone hides. */
function rawParents(repo: string, sha: string): string[] | null {
  const raw = git(repo, ["cat-file", "commit", sha]);
  if (raw === null) return null;
  const header = raw.slice(0, raw.indexOf("\n\n") >>> 0);
  return header
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7));
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
function git(repo: string, args: string[], stdin?: Uint8Array): string | null {
  return run(["git", "--literal-pathspecs", ...PINNED_CONFIG, "-C", repo, ...args], stdin);
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
