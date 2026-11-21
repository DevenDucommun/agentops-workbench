import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { getGitChanges, mergeGitChanges, parseGitNumstat, parseGitStatus } from "../src/git";

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

test("keeps non-ASCII paths literal whatever the user's quotePath setting", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-git-")));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  git("init", "-q");
  git("config", "core.quotePath", "true");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(dir, "new", "deep"), { recursive: true });
  writeFileSync(join(dir, "new", "deep", "example.ts"), "export {};\n");
  writeFileSync(join(dir, "new", "deep", "café.ts"), "export {};\n");

  expect(getGitChanges(dir).map((change) => change.path).sort()).toEqual(["new/deep/café.ts", "new/deep/example.ts"]);
});
