import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { blameFile, commitsTouching, getCommitInfo, parseBlamePorcelain, parseTrailers, unquoteGitPath } from "../src/gitBlame";

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

  test("commitsTouching follows renames, newest first", () => {
    const { dir, first, second, git: g } = repo();
    g(dir, "mv", "math.js", "sum.js");
    g(dir, "commit", "-q", "-m", "refactor: rename");
    const third = g(dir, "rev-parse", "HEAD");
    expect(commitsTouching(dir, "sum.js")).toEqual([third, second, first]);
    expect(commitsTouching(dir, "sum.js", { limit: 1 })).toEqual([third]);
  });

  test("blameFile reports a non-ASCII original path unquoted", () => {
    const { dir, git: g } = repo();
    writeFileSync(join(dir, "café"), "x\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "add café");
    expect(blameFile(dir, "café")[0]?.originalPath).toBe("café");
  });

  test("commitsTouching includes a merge that created the file during conflict resolution", () => {
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
    expect(commitsTouching(dir, "merge-only")).toEqual([merge]);
    expect(commitsTouching(dir, "math.js")[0]).toBe(merge);
  });

  test("commitsTouching treats the path literally and limit 0 returns nothing", () => {
    const { dir, git: g } = repo();
    writeFileSync(join(dir, "[one].txt"), "1\n");
    writeFileSync(join(dir, "o.txt"), "o\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "add both");
    const both = g(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "o.txt"), "o2\n");
    g(dir, "commit", "-q", "-am", "edit o");
    expect(commitsTouching(dir, "[one].txt")).toEqual([both]);
    expect(commitsTouching(dir, "*.txt")).toEqual([]);
    expect(commitsTouching(dir, "math.js", { limit: 0 })).toEqual([]);
  });

  test("the wrappers return empty results when git cannot be started", () => {
    const { dir } = repo();
    const script = `import { blameFile, commitsTouching, getCommitInfo } from ${JSON.stringify(join(import.meta.dir, "..", "src", "gitBlame.ts"))};
console.log(JSON.stringify([blameFile(${JSON.stringify(dir)}, "math.js"), commitsTouching(${JSON.stringify(dir)}, "math.js"), getCommitInfo(${JSON.stringify(dir)}, "HEAD")]));`;
    const file = join(dir, "probe.ts");
    writeFileSync(file, script);
    const result = spawnSync(process.execPath, [file], { env: { PATH: join(dir, "no-git-here") }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([[], [], null]);
  });

  test("missing paths, revisions and repositories return empty results, not errors", () => {
    const { dir } = repo();
    expect(blameFile(dir, "nope.js")).toEqual([]);
    expect(getCommitInfo(dir, "deadbeef")).toBeNull();
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "agentops-not-a-repo-")));
    expect(blameFile(notRepo, "math.js")).toEqual([]);
    expect(commitsTouching(notRepo, "math.js")).toEqual([]);
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

    test("a rename does not hide the merge that created the file", () => {
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
      const rename = g(dir, "rev-parse", "HEAD");
      expect(commitsTouching(dir, "moved")).toEqual([rename, merge]);
      expect(blameFile(dir, "moved")[0]).toMatchObject({ sha: merge, originalPath: "created" });
    });

    test("a merge that leaves the file as one parent had it, or does not touch it, is not listed", () => {
      const { dir, first, second, git: g } = repo();
      g(dir, "checkout", "-q", "-b", "side");
      writeFileSync(join(dir, "math.js"), "side\n");
      g(dir, "commit", "-q", "-am", "side change");
      const side = g(dir, "rev-parse", "HEAD");
      g(dir, "checkout", "-q", "-");
      writeFileSync(join(dir, "other"), "o\n");
      g(dir, "add", "-A");
      g(dir, "commit", "-q", "-m", "main other");
      g(dir, "merge", "-q", "--no-ff", "-m", "merge takes side", "side");
      g(dir, "checkout", "-q", "-b", "side2");
      writeFileSync(join(dir, "other"), "o2\n");
      g(dir, "commit", "-q", "-am", "side2 other");
      g(dir, "checkout", "-q", "-");
      g(dir, "merge", "-q", "--no-ff", "-m", "merge untouched", "side2");
      expect(commitsTouching(dir, "math.js")).toEqual([side, second, first]);
      // The newest log entries are merges with nothing at the path; the limit still fills.
      expect(commitsTouching(dir, "math.js", { limit: 1 })).toEqual([side]);
      expect(commitsTouching(dir, "math.js", { limit: 2 })).toEqual([side, second]);
    });

    test("a reused filename does not inherit the deleted file's history", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "target"), "t\n");
      gAt(dir, 1, "add", "-A");
      gAt(dir, 1, "commit", "-q", "-m", "A");
      gAt(dir, 2, "rm", "-q", "target");
      gAt(dir, 2, "commit", "-q", "-m", "D");
      writeFileSync(join(dir, "source"), "unrelated\nsource content\nmore\n");
      gAt(dir, 3, "add", "-A");
      gAt(dir, 3, "commit", "-q", "-m", "S");
      const source = gAt(dir, 3, "rev-parse", "HEAD");
      gAt(dir, 4, "mv", "source", "target");
      gAt(dir, 4, "commit", "-q", "-m", "R");
      const rename = gAt(dir, 4, "rev-parse", "HEAD");
      expect(commitsTouching(dir, "target")).toEqual([rename, source]);
    });

    test("a limit keeps the newest commits in Git's date order", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "f"), "base\n");
      gAt(dir, 1, "add", "-A");
      gAt(dir, 1, "commit", "-q", "-m", "base");
      const at = (seconds: number, content: string) => {
        writeFileSync(join(dir, "f"), `${content}\n`);
        gAt(dir, seconds, "commit", "-q", "-am", content);
        return gAt(dir, seconds, "rev-parse", "HEAD");
      };
      gAt(dir, 1, "checkout", "-q", "-b", "b");
      const b20 = at(20, "b20");
      const b30 = at(30, "b30");
      gAt(dir, 1, "checkout", "-q", "-");
      const a10 = at(10, "a10");
      const a40 = at(40, "a40");
      conflictingMerge(dir, "b", dated(50));
      const m50 = at(50, "m50");
      expect(commitsTouching(dir, "f", { limit: 2 })).toEqual([m50, a40]);
      expect(commitsTouching(dir, "f").slice(0, 5)).toEqual([m50, a40, b30, b20, a10]);
    });

    test("a 30,000-commit history is listed without per-commit arguments", () => {
      const dir = emptyRepo();
      const parts = ["blob\nmark :1\ndata 2\na\nblob\nmark :2\ndata 2\nb\n"];
      for (let i = 1; i <= 30_000; i++) parts.push(`commit refs/heads/main\ncommitter synthetic <synthetic> ${i} +0000\ndata 1\nc\nM 100644 :${(i % 2) + 1} f\n\n`);
      const imported = Bun.spawnSync(["git", "-C", dir, "fast-import", "--quiet"], { stdin: new TextEncoder().encode(parts.join("")), stdout: "pipe", stderr: "pipe" });
      expect(imported.exitCode).toBe(0);
      git(dir, "checkout", "-q", "main");
      const head = git(dir, "rev-parse", "HEAD");
      expect(commitsTouching(dir, "f", { limit: 1 })).toEqual([head]);
      const all = commitsTouching(dir, "f");
      expect(all).toHaveLength(30_000);
      expect(all[0]).toBe(head);
    }, 10_000);

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

    test("a clean merge of a rename with an edit is listed, followed by both sides", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "old"), "one\ntwo\nthree\nfour\n");
      const base = commitAt(dir, 1, "B");
      gAt(dir, 1, "checkout", "-q", "-b", "topic");
      gAt(dir, 2, "mv", "old", "new");
      const rename = commitAt(dir, 2, "R");
      gAt(dir, 2, "checkout", "-q", "-");
      writeFileSync(join(dir, "old"), "one\ntwo\nthree\nFOUR\n");
      const edit = commitAt(dir, 3, "E");
      gAt(dir, 4, "merge", "-q", "--no-ff", "-m", "M", "topic");
      const merge = gAt(dir, 4, "rev-parse", "HEAD");
      expect(getCommitInfo(dir, merge)?.parents).toEqual([edit, rename]);
      expect(commitsTouching(dir, "new")).toEqual([merge, edit, rename, base]);
      expect(commitsTouching(dir, "new", { limit: 1 })).toEqual([merge]);
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
      expect(commitsTouching(shallow, "stable")).toEqual([]);
    });

    test("log.showRoot=false does not hide the root commit", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "untouched"), "u\n");
      writeFileSync(join(dir, "other"), "1\n");
      const root = commitAt(dir, 1, "root");
      writeFileSync(join(dir, "other"), "2\n");
      commitAt(dir, 2, "edit other");
      git(dir, "config", "log.showRoot", "false");
      expect(commitsTouching(dir, "untouched")).toEqual([root]);
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

    test("history stops at a deletion: a recreated path starts fresh", () => {
      const dir = emptyRepo();
      writeFileSync(join(dir, "source"), "first file\n");
      commitAt(dir, 1, "A");
      gAt(dir, 2, "rm", "-q", "source");
      commitAt(dir, 2, "D");
      writeFileSync(join(dir, "source"), "an unrelated second file\n");
      const recreated = commitAt(dir, 3, "N");
      expect(commitsTouching(dir, "source")).toEqual([recreated]);
      expect(blameFile(dir, "source")[0]?.sha).toBe(recreated);
    });
  });
});
