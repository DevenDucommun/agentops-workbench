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
