// Git blame and commit helpers for provenance (forensic recorder spec R3.1,
// R3.2; task T3.1). Pure parsers plus thin `git` wrappers that never throw:
// a missing repository, path or commit returns an empty result or null.

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
  /** Paths changed relative to the first parent (or added, for a root commit). */
  files: string[];
};

const NULL_SHA = /^0{40}$|^0{64}$/;
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
 * `Key: value` trailers from the last paragraph of a commit message. As in Git, a
 * trailer starts in the first column and an indented line continues the previous
 * one (values are unfolded with a space). An indented `Key: value` is not a trailer.
 */
export function parseTrailers(message: string): Array<{ key: string; value: string }> {
  const paragraphs = message.replace(/\s+$/, "").split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return [];
  const trailers: Array<{ key: string; value: string }> = [];
  for (const line of (paragraphs.at(-1) as string).split("\n")) {
    const start = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
    if (start) {
      trailers.push({ key: start[1] as string, value: (start[2] as string).trim() });
      continue;
    }
    const previous = trailers.at(-1);
    if (!previous || !/^[ \t]+\S/.test(line)) return [];
    previous.value = `${previous.value} ${line.trim()}`.trim();
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
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
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
  return new TextDecoder().decode(new Uint8Array(bytes));
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

/** Commit metadata, trailers and changed paths, or null when git cannot resolve `rev`. */
export function getCommitInfo(repo: string, rev: string): CommitInfo | null {
  const SEP = "\u001f";
  const header = git(repo, ["show", "-s", `--format=%H${SEP}%P${SEP}%at${SEP}%s${SEP}%B`, `${rev}^{commit}`]);
  if (header === null) return null;
  const [sha, parents, authorTime, subject, ...body] = header.split(SEP);
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const parentShas = (parents ?? "").split(" ").filter(Boolean);
  // Without an explicit base, diff-tree prints nothing for a merge commit, so
  // compare against the first parent; a root commit lists everything it adds.
  const first = parentShas[0];
  const files = git(repo, first ? ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", first, sha] : ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha]);
  return {
    sha,
    parents: parentShas,
    authorTime: Number(authorTime),
    subject: subject ?? "",
    trailers: parseTrailers(body.join(SEP)),
    files: files === null ? [] : files.split("\0").filter(Boolean)
  };
}

/**
 * Full SHAs of the commits that touched `path`, newest first. `path` is literal,
 * never a pattern. Renames are followed, and merges that changed the path (such as
 * a conflict resolution that created it) are included, which `--follow` alone skips.
 * `limit: 0` returns no commits.
 */
export function commitsTouching(repo: string, path: string, options: { limit?: number } = {}): string[] {
  if (options.limit !== undefined && options.limit <= 0) return [];
  const shas = (out: string | null) => (out ?? "").split("\n").filter((line) => /^[0-9a-f]{40,64}$/.test(line));
  const followed = git(repo, ["log", "--follow", "--format=%H", "--", path]);
  if (followed === null) return [];
  const touching = new Set([...shas(followed), ...shas(git(repo, ["log", "--format=%H", "--", path]))]);
  if (touching.size === 0) return [];
  // Topological order keeps a merge ahead of its parents even when their commit times tie.
  const sorted = shas(git(repo, ["rev-list", "--topo-order", ...touching])).filter((sha) => touching.has(sha));
  return options.limit === undefined ? sorted : sorted.slice(0, options.limit);
}

/** Runs git with literal pathspecs. Null when git exits nonzero or cannot be started. */
function git(repo: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", "--literal-pathspecs", "-C", repo, ...args], { stdout: "pipe", stderr: "ignore" });
    return proc.exitCode === 0 ? proc.stdout.toString() : null;
  } catch {
    return null;
  }
}
