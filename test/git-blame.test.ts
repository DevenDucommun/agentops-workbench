import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { blameFile, commitsTouching, getCommitInfo, parseBlamePorcelain, parseTrailers } from "../src/gitBlame";

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

describe("git wrappers", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
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
    expect(merge?.files.sort()).toEqual(["a.js", "b.js"]);
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

  test("missing paths, revisions and repositories return empty results, not errors", () => {
    const { dir } = repo();
    expect(blameFile(dir, "nope.js")).toEqual([]);
    expect(getCommitInfo(dir, "deadbeef")).toBeNull();
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "agentops-not-a-repo-")));
    expect(blameFile(notRepo, "math.js")).toEqual([]);
    expect(commitsTouching(notRepo, "math.js")).toEqual([]);
  });
});
