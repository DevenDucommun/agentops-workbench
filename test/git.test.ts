import { expect, test } from "bun:test";
import { mergeGitChanges, parseGitNumstat, parseGitStatus } from "../src/git";

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
