import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git blame and commit helpers for provenance (forensic recorder spec R3.1,
// R3.2; task T3.1). Parsers plus thin `git` wrappers that never throw: a
// missing repository, path or commit returns an empty result or null. Trailer parsing follows Git’s own rules.

export type BlameLine = {
  /** Full commit SHA. All zeros for uncommitted lines. */
  sha: string;
  /** Line number in the commit that introduced it. */
  originalLine: number;
  /** Line number in the blamed revision. */
  finalLine: number;
  /** Path in the introducing commit. Non-UTF-8 names use lone surrogates for non-ASCII bytes. */
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
   * Non-UTF-8 names use the same byte-preserving representation as originalPath.
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
 * `Key: value` trailers of a commit message, exactly as Git reports them for a
 * commit with that message (`%(trailers:only,unfold)`, as getCommitInfo reads
 * them): the message is written as a commit to a throwaway object store and Git
 * returns structured key/value pairs, so a configured key that is a prefix of
 * another (`Bug #` and `Bug #4`) is never split by guesswork. The trailer
 * settings of the repository at `cwd` apply. Empty when git is unavailable.
 */
export function parseTrailers(message: string, cwd = process.cwd()): Array<{ key: string; value: string }> {
  const settings: string[] = [];
  // Trailer settings, plus the comment character Git uses to skip comment lines
  // when it finds the trailer block, so the throwaway store parses as the repository does.
  for (const entry of (run(["git", "-C", cwd, "config", "--null", "--get-regexp", "^(trailer\\.|core\\.comment(char|string)$)"]) ?? "").split("\0").filter(Boolean)) {
    const end = entry.indexOf("\n");
    if (end > 0) settings.push("-c", `${entry.slice(0, end)}=${entry.slice(end + 1)}`);
  }
  let store: string;
  try {
    store = mkdtempSync(join(tmpdir(), "agentops-trailers-"));
  } catch {
    return [];
  }
  try {
    // Every repository location is pinned to the throwaway store, so inherited
    // GIT_DIR, GIT_OBJECT_DIRECTORY or alternates never route a write elsewhere.
    // run() drops every inherited repository variable; only the throwaway store is named.
    const isolated = { GIT_DIR: store };
    if (run(["git", "init", "--bare", "-q", store], undefined, isolated) === null) return [];
    const inStore = ["git", ...PINNED_CONFIG, ...settings];
    const tree = run([...inStore, "hash-object", "-t", "tree", "-w", "--stdin"], new Uint8Array(), isolated)?.trim();
    if (!tree || !SHA.test(tree)) return [];
    const body = `tree ${tree}\nauthor agentops <agentops> 0 +0000\ncommitter agentops <agentops> 0 +0000\n\n${message}`;
    const commit = run([...inStore, "hash-object", "-t", "commit", "-w", "--stdin"], new TextEncoder().encode(body), isolated)?.trim();
    if (!commit || !SHA.test(commit)) return [];
    const out = run([...inStore, "show", "-s", "--encoding=UTF-8", "--format=%(trailers:only,unfold,separator=%x00,key_value_separator=%x00)", commit], undefined, isolated);
    if (out === null) return [];
    const fields = out.replace(/\n$/, "").split("\0");
    const trailers: Array<{ key: string; value: string }> = [];
    for (let i = 0; i + 1 < fields.length; i += 2) trailers.push({ key: fields[i] as string, value: fields[i + 1] as string });
    return trailers;
  } finally {
    try {
      rmSync(store, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory never fails the parse.
    }
  }
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
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    // Match the byte-preserving Git path representation used by repo reports.
    // Valid Unicode never decodes to a lone surrogate.
    return bytes.map((byte) => String.fromCharCode(byte < 0x80 ? byte : 0xdc00 + byte)).join("");
  }
}

/**
 * Blames `path` at `rev` (default HEAD; `null` blames the working tree,
 * including uncommitted lines). `lines` limits the range, 1-based inclusive.
 */
export function blameFile(repo: string, path: string, options: { rev?: string | null; lines?: [number, number] } = {}): BlameLine[] {
  const args = ["blame", "--porcelain"];
  if (options.lines) args.push("-L", `${options.lines[0]},${options.lines[1]}`);
  const rev = options.rev === undefined ? "HEAD" : options.rev;
  if (rev !== null) {
    // Resolve the revision first: an unresolvable one (or one that looks like an
    // option, such as --root) returns [] instead of reaching blame as a flag.
    // Resolve the revision as written (a search such as :/text must not gain a
    // suffix), then require that object to be a commit.
    const object = git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", rev])?.trim();
    if (!object || !SHA.test(object)) return [];
    const commit = git(repo, ["rev-parse", "--verify", "--quiet", `${object}^{commit}`])?.trim();
    if (!commit || !SHA.test(commit)) return [];
    args.push(commit);
  }
  args.push("--");
  const out = hasNonUtf8Bytes(path) ? gitWithBytePath(repo, args, path) : git(repo, [...args, path]);
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
  const object = git(repo, ["rev-parse", "--verify", "--end-of-options", rev])?.trim();
  if (!object || !SHA.test(object)) return null;
  const header = git(repo, ["show", "-s", "--encoding=UTF-8", `--format=${format}`, `${object}^{commit}`, "--"]);
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
  const files = git(repo, first ? ["diff-tree", "--no-commit-id", "--name-only", "-r", first, sha, "--"] : ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", sha, "--"]);
  return {
    sha,
    parents: parentShas,
    authorTime: Number(authorTime),
    subject: subject ?? "",
    trailers,
    files: files === null ? (first ? null : []) : files.split("\n").filter(Boolean).map(unquoteGitPath)
  };
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

/**
 * Runs git with literal pathspecs, pinning the settings that would change the
 * output these parsers read: UTF-8 log output, root commits shown, no implicit
 * --follow, no signature blocks, no color. Null when git exits nonzero or cannot
 * be started.
 */
function git(repo: string, args: string[]): string | null {
  return run(["git", "--literal-pathspecs", ...PINNED_CONFIG, "-C", repo, ...args]);
}

/** Whether a path holds bytes that were not valid UTF-8 (lone surrogates U+DC80-U+DCFF, as unquoteGitPath produces). */
function hasNonUtf8Bytes(path: string): boolean {
  return /[\uDC80-\uDCFF]/u.test(path);
}

/** The path's original bytes: lone surrogates map back to their byte, everything else is UTF-8. */
function pathBytes(path: string): number[] {
  const bytes: number[] = [];
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (char.length === 1 && code >= 0xdc80 && code <= 0xdcff) bytes.push(code - 0xdc00);
    else bytes.push(...new TextEncoder().encode(char));
  }
  return bytes;
}

/**
 * Runs git with a final path argument made of the path's exact bytes. A process
 * argument from JavaScript is always UTF-8, which would turn a non-UTF-8 byte
 * into U+FFFD and select a different file, so the shell builds the argument
 * from octal escapes instead (the trailing X keeps a final newline intact).
 */
function gitWithBytePath(repo: string, args: string[], path: string): string | null {
  const escaped = pathBytes(path).map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
  const script = 'p=$(printf "%bX" "$AGENTOPS_GIT_PATH"); exec "$@" "${p%X}"';
  return run(["sh", "-c", script, "sh", "git", "--literal-pathspecs", ...PINNED_CONFIG, "-C", repo, ...args], undefined, { AGENTOPS_GIT_PATH: escaped });
}

const PINNED_CONFIG = [
  "-c",
  "core.quotePath=true",
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

/**
 * Runs a command without any inherited GIT_* variable; `env` adds or overrides
 * entries. Every helper names its repository and reads only local state, so a
 * variable from a Git hook, worktree script or sibling clone (GIT_DIR,
 * GIT_COMMON_DIR, GIT_SHALLOW_FILE, GIT_CONFIG_*, ...) must never change what
 * Git reads.
 */
function run(argv: string[], stdin?: Uint8Array, env?: Record<string, string>): string | null {
  try {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("GIT_")) merged[key] = value;
    }
    Object.assign(merged, env ?? {});
    const proc = Bun.spawnSync(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "ignore", env: merged });
    return proc.exitCode === 0 ? proc.stdout.toString() : null;
  } catch {
    return null;
  }
}
