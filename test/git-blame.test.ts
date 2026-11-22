import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { blameFile, getCommitInfo, parseBlamePorcelain, parseTrailers, unquoteGitPath } from "../src/gitBlame";

const A = "a".repeat(40);
const B = "b".repeat(40);
const NULL = "0".repeat(40);

describe("parseBlamePorcelain", () => {
  test("reuses commit metadata printed only on the commit's first line", () => {
    const porcelain = [
      `${A} 1 1 2`,
      "author Synthetic",
      "author-time 1700000000",
      "summary first commit",
      "filename src/old.ts",
      "\texport function add(a, b) {",
      `${A} 2 2`,
      "\t  return a + b;",
      `${B} 5 3 1`,
      "author-time 1700000500",
      "summary second commit",
      "previous " + A + " src/old.ts",
      "filename src/math.ts",
      "\t}",
      ""
    ].join("\n");
    expect(parseBlamePorcelain(porcelain)).toEqual([
      { sha: A, originalLine: 1, finalLine: 1, originalPath: "src/old.ts", authorTime: 1700000000, summary: "first commit", uncommitted: false, content: "export function add(a, b) {" },
      { sha: A, originalLine: 2, finalLine: 2, originalPath: "src/old.ts", authorTime: 1700000000, summary: "first commit", uncommitted: false, content: "  return a + b;" },
      { sha: B, originalLine: 5, finalLine: 3, originalPath: "src/math.ts", authorTime: 1700000500, summary: "second commit", uncommitted: false, content: "}" }
    ]);
  });

  test("marks uncommitted lines and keeps tabs inside the content", () => {
    const [line] = parseBlamePorcelain([`${NULL} 1 1 1`, "summary Not Committed Yet", "filename a.ts", "\t\tindented"].join("\n"));
    expect(line).toMatchObject({ uncommitted: true, content: "\tindented" });
  });

  test("ignores garbage", () => {
    expect(parseBlamePorcelain("not porcelain\n")).toEqual([]);
  });
});

describe("parseTrailers", () => {
  test("reads the trailer block at the end of the message", () => {
    expect(parseTrailers("fix: add\n\nBody text.\n\nAgentOps-Session: s-1\nCo-Authored-By: Someone <x>\n")).toEqual([
      { key: "AgentOps-Session", value: "s-1" },
      { key: "Co-Authored-By", value: "Someone <x>" }
    ]);
  });

  test("a subject-only message or a prose last paragraph has no trailers", () => {
    expect(parseTrailers("fix: add")).toEqual([]);
    expect(parseTrailers("fix: add\n\nThis explains: the fix\nand more prose")).toEqual([]);
  });
});

describe("review regressions", () => {
  test("indented Key: value lines are not trailers; indented lines continue the previous trailer", () => {
    expect(parseTrailers("subject\n\n    AgentOps-Session: sample")).toEqual([]);
    expect(parseTrailers("subject\n\nAgentOps-Session: real\n  continued")).toEqual([{ key: "AgentOps-Session", value: "real continued" }]);
    expect(parseTrailers("subject\n\n  continued\nAgentOps-Session: real")).toEqual([]);
  });

  test("Git's C-quoted paths are decoded, including octal UTF-8 bytes", () => {
    expect(unquoteGitPath('"caf\\303\\251"')).toBe("café");
    expect(unquoteGitPath('"a\\tb\\nc\\"d\\\\e"')).toBe('a\tb\nc"d\\e');
    expect(unquoteGitPath("plain.ts")).toBe("plain.ts");
    const [line] = parseBlamePorcelain([`${A} 1 1 1`, 'filename "caf\\303\\251"', "\tx"].join("\n"));
    expect(line?.originalPath).toBe("café");
  });
});

describe("git wrappers", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };

  /** Starts a merge that is expected to conflict; asserts that it left MERGE_HEAD behind. */
  const conflictingMerge = (cwd: string, branch: string, env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", "merge", "-q", branch], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env }
    });
    expect(r.exitCode).toBe(1);
    git(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD");
  };

  function repo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-blame-")));
    git(dir, "init", "-q");
    writeFileSync(join(dir, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat: add");
    const first = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
    git(dir, "commit", "-q", "-am", "fix: add returns the sum\n\nAgentOps-Session: 0a1b2c3d-0005");
    const second = git(dir, "rev-parse", "HEAD");
    return { dir, first, second, git };
  }

  test("single-commit revision expressions and names shared with files resolve to the requested commit", () => {
    const { dir, first, second } = repo();
    expect(getCommitInfo(dir, ":/feat: add")?.sha).toBe(first);
    writeFileSync(join(dir, "HEAD^{commit}"), "path");
    expect(getCommitInfo(dir, "HEAD")?.sha).toBe(second);
  });

  test("a revision range has no single commit record", () => {
    const { dir } = repo();
    expect(getCommitInfo(dir, "HEAD~1..HEAD")).toBeNull();
  });

  test("configured trailer keys keep their spelling and separator", () => {
    const { dir, git: g } = repo();
    g(dir, "config", "trailer.separators", ":#=");
    g(dir, "config", "trailer.bug.key", "Bug #");
    const message = "subject\n\nBug #42";
    g(dir, "commit", "-q", "--allow-empty", "-m", message);
    const expected = [{ key: "Bug #", value: "42" }];
    expect(getCommitInfo(dir, "HEAD")?.trailers).toEqual(expected);
    const previous = process.cwd();
    try {
      process.chdir(dir);
      expect(parseTrailers(message)).toEqual(expected);
      const value = String.fromCharCode(0xa0) + "42";
      expect(parseTrailers("subject\n\nbug=" + value)).toEqual([{ key: "Bug #", value }]);
    } finally {
      process.chdir(previous);
    }
  });

  test("different invalid UTF-8 tree paths retain distinct identities in commit info and blame", () => {
    const { dir, git: g } = repo();
    const blob = g(dir, "rev-parse", "HEAD:math.js");
    const put = (data: Buffer) => {
      const result = Bun.spawnSync(["git", "update-index", "-z", "--index-info"], { cwd: dir, stdin: data });
      expect(result.exitCode).toBe(0);
    };
    const entry = (prefix: string, byte: number) => Buffer.concat([Buffer.from(prefix + "\tfile-"), Buffer.from([byte, 0])]);
    put(Buffer.concat([entry("100644 " + blob, 254), entry("100644 " + blob, 255)]));
    g(dir, "commit", "-qm", "distinct names");
    const expected = [254, 255].map((byte) => "file-" + String.fromCharCode(0xdc00 + byte));
    expect(getCommitInfo(dir, "HEAD")?.files).toEqual(expected);
    const zero = "0".repeat(blob.length);
    put(Buffer.concat([entry("0 " + zero, 254), Buffer.from("100644 " + blob + "\treadable\0")]));
    g(dir, "commit", "-qm", "rename");
    g(dir, "config", "core.quotePath", "false");
    expect(blameFile(dir, "readable")[0]?.originalPath).toBe(expected[0]);
  });

  test("blameFile attributes each line to the commit that last changed it", () => {
    const { dir, first, second } = repo();
    expect(blameFile(dir, "math.js").map((line) => [line.finalLine, line.sha, line.content])).toEqual([
      [1, first, "export function add(a, b) {"],
      [2, second, "  return a + b;"],
      [3, first, "}"]
    ]);
    expect(blameFile(dir, "math.js", { lines: [2, 2] }).map((line) => line.sha)).toEqual([second]);
    expect(blameFile(dir, "math.js", { rev: first }).every((line) => line.sha === first)).toBe(true);
  });

  test("blaming the working tree shows uncommitted lines", () => {
    const { dir } = repo();
    writeFileSync(join(dir, "math.js"), "export function add(a, b) {\n  return b + a;\n}\n");
    const [, changed] = blameFile(dir, "math.js", { rev: null });
    expect(changed).toMatchObject({ uncommitted: true, content: "  return b + a;" });
  });

  test("getCommitInfo returns parents, subject, trailers and changed files", () => {
    const { dir, first, second } = repo();
    expect(getCommitInfo(dir, second.slice(0, 7))).toMatchObject({
      sha: second,
      parents: [first],
      subject: "fix: add returns the sum",
      trailers: [{ key: "AgentOps-Session", value: "0a1b2c3d-0005" }],
      files: ["math.js"]
    });
    expect(getCommitInfo(dir, first)).toMatchObject({ parents: [], files: ["math.js"], trailers: [] });
  });

  test("getCommitInfo lists a merge commit's files relative to its first parent", () => {
    const { dir, second, git: g } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "a.js"), "a\n");
    writeFileSync(join(dir, "b.js"), "b\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "feat: side files");
    g(dir, "checkout", "-q", "-");
    writeFileSync(join(dir, "c.js"), "c\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "feat: main file");
    const mainTip = g(dir, "rev-parse", "HEAD");
    g(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = getCommitInfo(dir, "HEAD");
    expect(merge?.parents).toHaveLength(2);
    expect(merge?.parents[0]).toBe(mainTip);
    expect(merge?.files?.sort()).toEqual(["a.js", "b.js"]);
    expect(getCommitInfo(dir, second)?.files).toEqual(["math.js"]);
  });

  test("blameFile reports a non-ASCII original path unquoted", () => {
    const { dir, git: g } = repo();
    writeFileSync(join(dir, "café"), "x\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "add café");
    expect(blameFile(dir, "café")[0]?.originalPath).toBe("café");
  });

  test("getCommitInfo keeps both parents of a conflict-resolution merge", () => {
    const { dir, git: g } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "math.js"), "side\n");
    g(dir, "commit", "-q", "-am", "side change");
    g(dir, "checkout", "-q", "-");
    writeFileSync(join(dir, "math.js"), "main\n");
    g(dir, "commit", "-q", "-am", "main change");
    conflictingMerge(dir, "side");
    writeFileSync(join(dir, "math.js"), "resolved\n");
    writeFileSync(join(dir, "merge-only"), "new\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "merge side");
    const merge = g(dir, "rev-parse", "HEAD");
    expect(getCommitInfo(dir, merge)?.parents).toHaveLength(2);
  });

  test("the wrappers return empty results when git cannot be started", () => {
    const { dir } = repo();
    const script = `import { blameFile, getCommitInfo } from ${JSON.stringify(join(import.meta.dir, "..", "src", "gitBlame.ts"))};
console.log(JSON.stringify([blameFile(${JSON.stringify(dir)}, "math.js"), getCommitInfo(${JSON.stringify(dir)}, "HEAD")]));`;
    const file = join(dir, "probe.ts");
    writeFileSync(file, script);
    const result = spawnSync(process.execPath, [file], { env: { PATH: join(dir, "no-git-here") }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([[], null]);
  });

  test("missing paths, revisions and repositories return empty results, not errors", () => {
    const { dir } = repo();
    expect(blameFile(dir, "nope.js")).toEqual([]);
    expect(getCommitInfo(dir, "deadbeef")).toBeNull();
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "agentops-not-a-repo-")));
    expect(blameFile(notRepo, "math.js")).toEqual([]);
  });

  describe("review round 3 regressions", () => {
    const dated = (seconds: number) => ({ GIT_AUTHOR_DATE: `@${seconds} +0000`, GIT_COMMITTER_DATE: `@${seconds} +0000` });
    const gAt = (cwd: string, seconds: number, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...dated(seconds) }
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    const emptyRepo = () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-blame-")));
      git(dir, "init", "-q");
      return dir;
    };

    test("blame follows a rename to the merge that created the file", () => {
      const { dir, git: g } = repo();
      g(dir, "checkout", "-q", "-b", "side");
      writeFileSync(join(dir, "math.js"), "side\n");
      g(dir, "commit", "-q", "-am", "side change");
      g(dir, "checkout", "-q", "-");
      writeFileSync(join(dir, "math.js"), "main\n");
      g(dir, "commit", "-q", "-am", "main change");
      conflictingMerge(dir, "side");
      writeFileSync(join(dir, "math.js"), "resolved\n");
      writeFileSync(join(dir, "created"), "created by the merge\n");
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", "merge side");
      const merge = g(dir, "rev-parse", "HEAD");
      expect(getCommitInfo(dir, merge)?.parents).toHaveLength(2);
      g(dir, "mv", "created", "moved");
      g(dir, "commit", "-q", "-m", "rename");
      expect(blameFile(dir, "moved")[0]).toMatchObject({ sha: merge, originalPath: "created" });
    });

    test("quoted paths keep astral characters and a leading U+FEFF", () => {
      expect(unquoteGitPath('"🚀\\tlog"')).toBe("🚀\tlog");
      expect(unquoteGitPath('"\\357\\273\\277lead\\t"')).toBe("﻿lead\t");
      expect(unquoteGitPath('"﻿lead\\t"')).toBe("﻿lead\t");
    });

    for (const quotePath of ["true", "false"]) {
      test(`blameFile reports Unicode filenames that Git quotes (core.quotePath=${quotePath})`, () => {
        const { dir, git: g } = repo();
        g(dir, "config", "core.quotePath", quotePath);
        for (const name of ["🚀\tlog", "﻿lead\t"]) {
          writeFileSync(join(dir, name), "x\n");
          g(dir, "add", "-A");
          g(dir, "commit", "-q", "-m", "add file");
          expect(blameFile(dir, name)[0]?.originalPath).toBe(name);
        }
      });
    }

    test("trailers follow Git's rules: whitespace before the separator, mixed final paragraphs", () => {
      expect(parseTrailers("subject\n\nAgentOps-Session : s1")).toEqual([{ key: "AgentOps-Session", value: "s1" }]);
      const mixed = "subject\n\nprose line here\nSigned-off-by: Synthetic <synthetic>\nAgentOps-Session: s1";
      const expected = [
        { key: "Signed-off-by", value: "Synthetic <synthetic>" },
        { key: "AgentOps-Session", value: "s1" }
      ];
      expect(parseTrailers(mixed)).toEqual(expected);
      const { dir, git: g } = repo();
      writeFileSync(join(dir, "math.js"), "changed\n");
      g(dir, "commit", "-q", "-am", mixed);
      expect(getCommitInfo(dir, "HEAD")?.trailers).toEqual(expected);
      writeFileSync(join(dir, "math.js"), "changed again\n");
      g(dir, "commit", "-q", "-am", "subject\n\nAgentOps-Session : s1");
      expect(getCommitInfo(dir, "HEAD")?.trailers).toEqual([{ key: "AgentOps-Session", value: "s1" }]);
    });

    test("a subject containing U+001F is returned whole", () => {
      const { dir, git: g } = repo();
      writeFileSync(join(dir, "math.js"), "changed\n");
      g(dir, "commit", "-q", "--cleanup=verbatim", "-am", "unit\u001fseparator\n\nAgentOps-Session: s1\n");
      expect(getCommitInfo(dir, "HEAD")).toMatchObject({ subject: "unit\u001fseparator", trailers: [{ key: "AgentOps-Session", value: "s1" }], files: ["math.js"] });
    });
  });

  describe("review round 4 regressions", () => {
    const gAt = (cwd: string, seconds: number, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_AUTHOR_DATE: `@${seconds} +0000`, GIT_COMMITTER_DATE: `@${seconds} +0000` }
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    const emptyRepo = () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-blame-")));
      git(dir, "init", "-q");
      return dir;
    };
    const commitAt = (dir: string, seconds: number, message: string) => {
      gAt(dir, seconds, "add", "-A");
      gAt(dir, seconds, "commit", "-q", "-m", message);
      return gAt(dir, seconds, "rev-parse", "HEAD");
    };

    test("commit metadata preserves parent order for a clean rename and edit merge", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "old"), "one\ntwo\nthree\nfour\n");
      commitAt(dir, 1, "B");
      gAt(dir, 1, "checkout", "-q", "-b", "topic");
      gAt(dir, 2, "mv", "old", "new");
      const rename = commitAt(dir, 2, "R");
      gAt(dir, 2, "checkout", "-q", "-");
      writeFileSync(join(dir, "old"), "one\ntwo\nthree\nFOUR\n");
      const edit = commitAt(dir, 3, "E");
      gAt(dir, 4, "merge", "-q", "--no-ff", "-m", "M", "topic");
      const merge = gAt(dir, 4, "rev-parse", "HEAD");
      expect(getCommitInfo(dir, merge)?.parents).toEqual([edit, rename]);
    });

    test("a shallow clone keeps the boundary commit's real parent and claims no changed files for it", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "changed"), "1\n");
      writeFileSync(join(dir, "stable"), "s\n");
      const parent = commitAt(dir, 1, "P");
      writeFileSync(join(dir, "changed"), "2\n");
      const child = commitAt(dir, 2, "C");
      expect(getCommitInfo(dir, child)).toMatchObject({ parents: [parent], files: ["changed"] });
      const clone = realpathSync(mkdtempSync(join(tmpdir(), "agentops-shallow-")));
      git(clone, "clone", "-q", "--depth", "1", `file://${dir}`, "c");
      const shallow = join(clone, "c");
      expect(getCommitInfo(shallow, "HEAD")).toMatchObject({ sha: child, parents: [parent], files: null });
    });

    test("i18n.logOutputEncoding does not corrupt subjects, blame summaries or trailers", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "f"), "x\n");
      gAt(dir, 1, "add", "-A");
      gAt(dir, 1, "commit", "-q", "-m", "café\n\nAgentOps-Session: é-1");
      git(dir, "config", "i18n.logOutputEncoding", "ISO-8859-1");
      expect(getCommitInfo(dir, "HEAD")).toMatchObject({ subject: "café", trailers: [{ key: "AgentOps-Session", value: "é-1" }] });
      expect(blameFile(dir, "f")[0]?.summary).toBe("café");
    });

    test("blame attributes a recreated file to its new commit", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "source"), "first file\n");
      commitAt(dir, 1, "A");
      gAt(dir, 2, "rm", "-q", "source");
      commitAt(dir, 2, "D");
      writeFileSync(join(dir, "source"), "an unrelated second file\n");
      const recreated = commitAt(dir, 3, "N");
      expect(blameFile(dir, "source")[0]?.sha).toBe(recreated);
    });
  });

  describe("review round 5 regressions", () => {
    const gAt = (cwd: string, seconds: number, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_AUTHOR_DATE: `@${seconds} +0000`, GIT_COMMITTER_DATE: `@${seconds} +0000` }
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    const emptyRepo = () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-blame-")));
      git(dir, "init", "-q");
      return dir;
    };
    const commitAt = (dir: string, seconds: number, message: string) => {
      gAt(dir, seconds, "add", "-A");
      gAt(dir, seconds, "commit", "-q", "-m", message);
      return gAt(dir, seconds, "rev-parse", "HEAD");
    };
    /** A merge expected to conflict, made with the synthetic identity; asserts the conflict. */
    const conflictAt = (dir: string, seconds: number, branch: string) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", "merge", "-q", branch], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_AUTHOR_DATE: `@${seconds} +0000`, GIT_COMMITTER_DATE: `@${seconds} +0000` }
      });
      expect(r.exitCode).toBe(1);
      gAt(dir, seconds, "rev-parse", "-q", "--verify", "MERGE_HEAD");
    };

    test("line blame preserves contributions from both parents of a merge", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "f"), "base\nkeep\n");
      const base = commitAt(dir, 1, "B");
      gAt(dir, 1, "checkout", "-q", "-b", "side");
      writeFileSync(join(dir, "f"), "side\nkeep\n");
      const side = commitAt(dir, 2, "S");
      gAt(dir, 2, "checkout", "-q", "-");
      gAt(dir, 3, "rm", "-q", "f");
      commitAt(dir, 3, "D");
      writeFileSync(join(dir, "f"), "unrelated\n");
      const recreated = commitAt(dir, 4, "N");
      conflictAt(dir, 5, "side");
      writeFileSync(join(dir, "f"), "unrelated\nside\nkeep\n");
      const merge = commitAt(dir, 5, "M");
      expect(getCommitInfo(dir, merge)?.parents).toHaveLength(2);
      expect(blameFile(dir, "f").map((line) => line.sha)).toEqual([recreated, side, base]);
    });

    test("parseTrailers keeps a value containing U+2028", () => {
      expect(parseTrailers("subject\n\nAgentOps-Session: a b")).toEqual([{ key: "AgentOps-Session", value: "a b" }]);
    });
  });
});

describe("review 6001159711: byte-exact blame paths and Git-structured trailers", () => {
  const scratch = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-blame-r8-")));
    const sh = (script: string) => Bun.spawnSync(["bash", "-c", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    sh("git init -q && git config user.name synthetic && git config user.email synthetic && git config commit.gpgsign false");
    return { dir, sh };
  };

  test("blameFile opens the exact file for each non-UTF-8 path that getCommitInfo returns", () => {
    const { dir, sh } = scratch();
    // Names end in bytes FE, FF and EF BF BD (the UTF-8 encoding of U+FFFD); staged through the index,
    // so no filesystem has to accept the invalid names.
    sh(
      "a=$(printf 'fe\\n' | git hash-object -w --stdin); b=$(printf 'ff\\n' | git hash-object -w --stdin); c=$(printf 'replacement\\n' | git hash-object -w --stdin); " +
        "{ printf '100644 %s\\tfile-\\376\\000' $a; printf '100644 %s\\tfile-\\377\\000' $b; printf '100644 %s\\tfile-\\357\\277\\275\\000' $c; } | git update-index -z --add --index-info && git commit -q -m add"
    );
    const info = getCommitInfo(dir, "HEAD");
    expect(info?.files).toHaveLength(3);
    const contents = (info?.files ?? []).map((path) => blameFile(dir, path).map((line) => line.content).join("\n")).sort();
    expect(contents).toEqual(["fe", "ff", "replacement"]);
  });

  test("parseTrailers matches Git when one configured key is a prefix of another", () => {
    const { dir, sh } = scratch();
    sh("git config trailer.separators ':#=' && git config trailer.bug.key 'Bug #' && git config trailer.ticket.key 'Bug #4'");
    const message = "subject\n\nbug=4: 99\n";
    expect(parseTrailers(message, dir)).toEqual([{ key: "Bug #", value: "4: 99" }]);
    sh(`git commit -q --allow-empty -F - <<'MSG'\n${message}MSG`);
    expect(parseTrailers(message, dir)).toEqual(getCommitInfo(dir, "HEAD")?.trailers ?? []);
  });
});

describe("review 6001325620: blame revisions, isolated trailer parsing, temp-directory failure", () => {
  test("blameFile returns [] for a revision that looks like an option or does not resolve", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-blame-r9-")));
    const sh = (script: string) => Bun.spawnSync(["bash", "-c", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    sh("git init -q && git config user.name synthetic && git config user.email synthetic && git config commit.gpgsign false && printf 'one\\n' > f && git add f && git commit -q -m one && printf 'edited\\n' > f");
    expect(blameFile(dir, "f", { rev: "--root" })).toEqual([]);
    expect(blameFile(dir, "f", { rev: "no-such-rev" })).toEqual([]);
    expect(blameFile(dir, "f")[0]?.content).toBe("one");
  });

  test("parseTrailers never writes into the caller's repository, even with GIT_DIR or GIT_OBJECT_DIRECTORY set", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-trailers-iso-")));
    Bun.spawnSync(["git", "init", "-q", dir]);
    const objects = () => Bun.spawnSync(["git", "-C", dir, "count-objects", "-v"], { stdout: "pipe" }).stdout.toString();
    const before = objects();
    const saved = { dir: process.env.GIT_DIR, obj: process.env.GIT_OBJECT_DIRECTORY };
    process.env.GIT_DIR = join(dir, ".git");
    process.env.GIT_OBJECT_DIRECTORY = join(dir, ".git", "objects");
    try {
      expect(parseTrailers("subject\n\nAgentOps-Session: s-1\n", dir)).toEqual([{ key: "AgentOps-Session", value: "s-1" }]);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.obj === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
      else process.env.GIT_OBJECT_DIRECTORY = saved.obj;
    }
    expect(objects()).toBe(before);
  });

  test("parseTrailers returns [] when no temporary directory can be created", () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), "agentops-no-such-dir", "nested");
    try {
      expect(() => parseTrailers("subject\n\nAgentOps-Session: s-1\n")).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

describe("review on 00d4cb7: inherited repository variables never redirect the helpers", () => {
  const repoWith = (content: string, subject: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-env-")));
    const sh = (script: string) => Bun.spawnSync(["bash", "-c", script], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    sh(`git init -q && git config user.name synthetic && git config user.email synthetic && git config commit.gpgsign false && printf '${content}\\n' > f && git add f && git commit -q -m '${subject}'`);
    return dir;
  };
  const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  test("with GIT_DIR pointing at another repository, blame and commit info read the named one", () => {
    const a = repoWith("from-a", "subject a");
    const b = repoWith("from-b", "subject b");
    withEnv({ GIT_DIR: join(a, ".git") }, () => {
      expect(blameFile(b, "f")[0]?.content).toBe("from-b");
      expect(getCommitInfo(b, "HEAD")?.subject).toBe("subject b");
    });
  });

  test("with GIT_COMMON_DIR set, parseTrailers leaves the caller's repository configuration untouched", () => {
    const a = repoWith("x", "s");
    withEnv({ GIT_COMMON_DIR: join(a, ".git") }, () => {
      expect(parseTrailers("subject\n\nAgentOps-Session: s-1\n", a)).toEqual([{ key: "AgentOps-Session", value: "s-1" }]);
    });
    const bare = Bun.spawnSync(["git", "-C", a, "config", "--bool", "core.bare"], { stdout: "pipe" }).stdout.toString().trim();
    expect(bare).toBe("false");
  });

  test("a search revision such as :/subject resolves for blame", () => {
    const a = repoWith("seeded", "seed-marker");
    expect(blameFile(a, "f", { rev: ":/seed-marker" })[0]?.content).toBe("seeded");
  });
});

describe("review 6009711110: no inherited GIT_* variable, and the repository's comment character", () => {
  const scratch = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-r10-")));
    const sh = (script: string) =>
      Bun.spawnSync(["bash", "-c", script], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    sh("git init -q && git config user.name synthetic && git config user.email synthetic && git config commit.gpgsign false");
    return { dir, sh };
  };

  test("an inherited GIT_SHALLOW_FILE never changes blame attribution", () => {
    const { dir, sh } = scratch();
    sh("printf 'line\\n' > f && git add f && git commit -q -m root && git commit -q --allow-empty -m tip");
    const root = sh("git rev-list --max-parents=0 HEAD").stdout.toString().trim();
    const tip = sh("git rev-parse HEAD").stdout.toString().trim();
    const shallow = join(dir, "shallow-from-elsewhere");
    writeFileSync(shallow, `${tip}\n`);
    const saved = process.env.GIT_SHALLOW_FILE;
    process.env.GIT_SHALLOW_FILE = shallow;
    try {
      expect(blameFile(dir, "f")[0]?.sha).toBe(root);
    } finally {
      if (saved === undefined) delete process.env.GIT_SHALLOW_FILE;
      else process.env.GIT_SHALLOW_FILE = saved;
    }
  });

  test("parseTrailers honours the repository's core.commentChar, as getCommitInfo does", () => {
    const { dir, sh } = scratch();
    sh("git config core.commentChar ';'");
    const message = "subject\n\nAgentOps-Session: s-1\n; a comment line\n";
    writeFileSync(join(dir, "msg"), message);
    sh("git commit -q --allow-empty --cleanup=verbatim -F msg");
    expect(parseTrailers(message, dir)).toEqual(getCommitInfo(dir, "HEAD")?.trailers ?? []);
  });
});
