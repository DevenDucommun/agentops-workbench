import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { runCli } from "../src/cli";
import { defaultConfig } from "../src/config";
import { getDashboardSession } from "../src/dashboardData";
import { parseForensicTextTranscript } from "../src/forensicText";
import { getGitChanges, parseGitStatusZ } from "../src/git";
import { parseJsonlTranscript } from "../src/parser";
import { getEvents, getRiskFlags, ingestTranscript, openStore } from "../src/store";

const tempStore = () => openStore(join(mkdtempSync(join(tmpdir(), "agentops-r3-")), "agentops.db"));

const originalCwd = process.cwd();
const originalDb = process.env.AGENTOPS_DB;
afterEach(() => {
  process.chdir(originalCwd);
  if (originalDb === undefined) delete process.env.AGENTOPS_DB;
  else process.env.AGENTOPS_DB = originalDb;
});

function jsonlSession(id: string, final: Record<string, string>) {
  const events = [
    { schemaVersion: "agentops.event.v1", type: "session", id },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "final_response", ...final }
  ];
  const store = tempStore();
  ingestTranscript(store, parseJsonlTranscript(`${id}.jsonl`, events.map((event) => JSON.stringify(event)).join("\n")), defaultConfig);
  analyzeSession(store, id, defaultConfig);
  const flags = getRiskFlags(store, id).map((flag) => flag.category);
  const evidence = getDashboardSession(store, id, defaultConfig)?.decision.evidence ?? [];
  const final_ = getEvents(store, id).find((event) => event.type === "final_response");
  store.db.close();
  return { flags, evidence, final: final_ };
}

test("a Markdown soft wrap inside a claim still matches, and the stored text keeps the newline", () => {
  const content = "Done. The type\ncheck passed.";
  const { flags, evidence, final } = jsonlSession("softwrap", { content });
  expect(flags).toContain("missing-typecheck-evidence");
  expect(evidence.find((row) => row.id === "typecheck")?.status).toBe("missing-evidence");
  expect(final?.text).toBe(content);
});

test("claims in an explicit summary are checked even when the body has content", () => {
  const { flags, evidence, final } = jsonlSession("summary-claim", {
    summary: "Lint passed.",
    content: "I edited the README to describe the new flag."
  });
  expect(flags).toContain("missing-lint-evidence");
  expect(evidence.find((row) => row.id === "lint")?.status).toBe("missing-evidence");
  expect(final?.summary).toBe("Lint passed.");
  expect(final?.text).toBe("I edited the README to describe the new flag.");
});

test("a summary derived from the body does not add claims of its own", () => {
  // The display summary is the clipped body; its truncated last word must not count as a claim.
  const body = `${"Updated the docs. ".repeat(6)}Then ran the linter over the passenger manifest module.`;
  const { flags } = jsonlSession("derived", { content: body });
  expect(flags).not.toContain("missing-lint-evidence");
});

function plainTextFlags(transcript: string): { flags: string[]; final: string } {
  const store = tempStore();
  const parsed = parseForensicTextTranscript("terminal.txt", transcript, defaultConfig);
  ingestTranscript(store, parsed, defaultConfig);
  analyzeSession(store, parsed.session.id, defaultConfig);
  const flags = getRiskFlags(store, parsed.session.id).map((flag) => flag.category);
  const finalEvent = getEvents(store, parsed.session.id).find((event) => event.type === "final_response");
  store.db.close();
  return { flags, final: finalEvent?.text ?? finalEvent?.summary ?? "" };
}

test("plain text: a named assistant turn after a user follow-up is the final response", () => {
  const { flags, final } = plainTextFlags(["$ bun test", "exit code 0", "Final: Tests passed.", "User: anything else?", "Codex: Lint is clean too."].join("\n"));
  expect(flags).toContain("missing-lint-evidence");
  expect(final).toBe("Lint is clean too.");
});

test("plain text: a single Claude turn ends at the next user turn", () => {
  const { flags, final } = plainTextFlags(
    ["$ bun test", "exit code 0", "Claude: All the tests passed after the change.", "User: Lint is clean as well, I checked it myself."].join("\n")
  );
  expect(flags).not.toContain("missing-lint-evidence");
  expect(final).toBe("All the tests passed after the change.");
});

test("git status: a worktree-side rename consumes its original-path field", () => {
  // ` R` comes from `git add -N` on a renamed file; the second field is the original path.
  expect(parseGitStatusZ(" R new-file.ts\0old-file.ts\0 M other.ts\0")).toEqual([
    { path: "new-file.ts", status: "R", additions: null, deletions: null },
    { path: "other.ts", status: "M", additions: null, deletions: null }
  ]);
});

function gitRepo(): { dir: string; git: (...args: string[]) => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-git-r3-")));
  const git = (...args: string[]) => {
    Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  };
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

test("git: an intent-to-add rename reports only the new path", () => {
  const { dir, git } = gitRepo();
  writeFileSync(join(dir, "old-file.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "add");
  renameSync(join(dir, "old-file.ts"), join(dir, "new-file.ts"));
  git("add", "-N", "new-file.ts");
  expect(getGitChanges(dir).map((change) => change.path)).toEqual(["new-file.ts"]);
});

test("git: a large untracked tree is listed in full, not dropped", () => {
  // More than 1 MiB of porcelain output (the old synchronous buffer) from a few thousand files.
  const { dir } = gitRepo();
  writeFileSync(join(dir, "README.md"), "y\n");
  const deep = join(dir, "vendor", "sdk".repeat(60));
  mkdirSync(deep, { recursive: true });
  const count = 6000;
  for (let i = 0; i < count; i++) writeFileSync(join(deep, `schema-file-number-${i}.json`), "");
  const changes = getGitChanges(dir);
  expect(changes).toHaveLength(count + 1);
  expect(changes.some((change) => change.path === "README.md")).toBe(true);
});

test("save pr fails visibly when git state cannot be read inside a repository", async () => {
  const { dir } = gitRepo();
  writeFileSync(join(dir, ".git", "index"), "garbage");
  process.chdir(dir);
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
  const audit = await runCli(["audit", join(originalCwd, "fixtures", "sample-session.jsonl"), "--quiet"]);
  expect(audit.exitCode).toBe(0);
  const pr = await runCli(["save", "pr", "latest", "--out", join(dir, "pr.md")]);
  expect(pr.exitCode).not.toBe(0);
  expect(pr.stderr).toContain("Unable to read git state");
});

test("save pr outside a git repository still reports an empty diff", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-nogit-r3-")));
  process.chdir(dir);
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
  const audit = await runCli(["audit", join(originalCwd, "fixtures", "sample-session.jsonl"), "--quiet"]);
  expect(audit.exitCode).toBe(0);
  const pr = await runCli(["save", "pr", "latest", "--out", join(dir, "pr.md")]);
  expect(pr.exitCode).toBe(0);
});
