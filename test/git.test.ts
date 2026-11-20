import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { getGitChanges, mergeGitChanges, parseGitNameStatus, parseGitNumstat, parseGitStatus } from "../src/git";

test("parses porcelain status output", () => {
  const changes = parseGitStatus([" M src/cli.ts", "A  docs/example.md", "?? fixtures/new.jsonl"].join("\n"));

  expect(changes).toEqual([
    { path: "src/cli.ts", status: "M", additions: null, deletions: null },
    { path: "docs/example.md", status: "A", additions: null, deletions: null },
    { path: "fixtures/new.jsonl", status: "??", additions: null, deletions: null }
  ]);
});

test("parses numstat output", () => {
  const stats = parseGitNumstat(["10\t2\tsrc/cli.ts", "-\t-\tassets/image.png"].join("\n"));

  expect(stats).toEqual([
    { path: "src/cli.ts", additions: 10, deletions: 2 },
    { path: "assets/image.png", additions: null, deletions: null }
  ]);
});

test("merges status and numstat by path", () => {
  const changes = mergeGitChanges(parseGitStatus(" M src/cli.ts\n?? fixtures/new.jsonl"), parseGitNumstat("10\t2\tsrc/cli.ts"));

  expect(changes).toEqual([
    { path: "fixtures/new.jsonl", status: "??", additions: null, deletions: null },
    { path: "src/cli.ts", status: "M", additions: 10, deletions: 2 }
  ]);
});

test("lists each untracked file inside a new directory, not the directory", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-git-")));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(dir, "nested-new"));
  writeFileSync(join(dir, "nested-new", "example.ts"), "export {};\n");

  expect(getGitChanges(dir).map((change) => change.path)).toEqual(["nested-new/example.ts"]);
});

test("with a base, committed branch work is reported; without one it is not", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-git-base-")));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  git("init", "-q", "-b", "trunk");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "old.ts"), "export const moved = 1;\nexport const kept = 2;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  git("mv", "old.ts", "renamed.ts");
  git("commit", "-q", "-am", "edit");
  writeFileSync(join(dir, "draft.ts"), "export {};\n");

  expect(getGitChanges(dir).map((change) => change.path)).toEqual(["draft.ts"]);
  expect(getGitChanges(dir, { base: "trunk" })).toEqual([
    { path: "a.ts", status: "M", additions: 1, deletions: 1 },
    { path: "draft.ts", status: "??", additions: null, deletions: null },
    { path: "renamed.ts", status: "R", additions: 0, deletions: 0 }
  ]);
  expect(() => getGitChanges(dir, { base: "no-such-ref" })).toThrow();
});

test("parses name-status output, keeping the new path of a rename", () => {
  expect(parseGitNameStatus(["M\tsrc/a.ts", "R087\tsrc/old.ts\tsrc/new.ts", "A\t\"odd name.ts\""].join("\n"))).toEqual([
    { path: "src/a.ts", status: "M", additions: null, deletions: null },
    { path: "src/new.ts", status: "R", additions: null, deletions: null },
    { path: "odd name.ts", status: "A", additions: null, deletions: null }
  ]);
});
