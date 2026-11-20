import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enrollRepository } from "../src/recorder/enrollment";
import { getFileChanges, getSessionCommits, openStore } from "../src/store";

const bin = resolve("bin/agentops");
let root: string, repo: string, linked: string, state: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=fixture", "-c", "user.email=fixture", ...args], { cwd });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().trim();
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-recorder-review-")));
  repo = join(root, "main"); linked = join(root, "linked"); state = join(root, "state");
  git(root, "init", "-q", repo);
  git(repo, "commit", "--allow-empty", "-qm", "base");
  git(repo, "branch", "other");
  git(repo, "worktree", "add", "-qb", "topic", linked);
  git(linked, "commit", "--allow-empty", "-qm", "topic");
  env = { ...process.env, AGENTOPS_STATE_DIR: state };
  delete env.AGENTOPS_DB;
  enrollRepository(repo, state);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function hook(session: string, event: string, body: Record<string, unknown> = {}) {
  const data = { session_id: session, cwd: linked, hook_event_name: event, ...body };
  const p = Bun.spawnSync([bin, "hook", event], { cwd: linked, env, stdin: Buffer.from(JSON.stringify(data)) });
  expect(p.exitCode).toBe(0);
}
function bash(session: string, command: string, tool_response: Record<string, unknown> = { stdout: "", stderr: "" }) {
  hook(session, "PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_response });
}
function dbPath() { return join(repo, ".agentops", "agentops.db"); }
function commits(session: string) {
  const db = openStore(dbPath());
  try { return getSessionCommits(db, session).map((c) => [c.sha, c.kind]); } finally { db.db.close(); }
}
test("push links use the source ref and omit grouped dry runs and deletions", () => {
  const other = git(repo, "rev-parse", "other"), head = git(linked, "rev-parse", "HEAD");
  expect(other).not.toBe(head);
  for (const [id, command, sha] of [
    ["refspec", "git push origin other:refs/heads/published", other],
    ["named", "git push origin other", other],
    ["compound", "git status --short && git push origin HEAD:refs/heads/current", head],
    ["dry", "git push -nv origin HEAD:refs/heads/current", ""],
    ["delete", "git push origin :refs/heads/demo", ""],
    ["missing", "git push origin unknown:refs/heads/demo", ""]
  ]) {
    bash(id, command); hook(id, "SessionEnd");
    expect(commits(id)).toEqual(sha ? [[sha, "pushed"]] : []);
  }
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "-q", remote);
  git(linked, "remote", "add", "fixture", remote);
  git(linked, "config", "remote.fixture.push", "other:refs/heads/published");
  const command = Bun.spawnSync(["git", "push", "fixture"], { cwd: linked });
  expect(command.exitCode).toBe(0);
  bash("configured", "git push fixture", { stdout: command.stdout.toString(), stderr: command.stderr.toString() });
  hook("configured", "SessionEnd");
  expect(commits("configured")).toEqual([[other, "pushed"]]);

});
test("auditing a commit followed by a push retains one canonical commit outside the repository", () => {
  const full = git(linked, "rev-parse", "HEAD");
  bash("twice", "git commit", { gitOperation: { commit: { sha: full.slice(0, 8), kind: "committed" } } });
  bash("twice", "git push origin HEAD"); hook("twice", "SessionEnd");
  expect(commits("twice")).toEqual([[full, "pushed"]]);
  const artifact = join(state, "spool", "twice.jsonl");
  const r = Bun.spawnSync([bin, "audit", artifact, "--quiet"], { cwd: root, env: { ...env, AGENTOPS_DB: dbPath() } });
  expect(r.exitCode).toBe(0);
  expect(commits("twice")).toEqual([[full, "pushed"]]);
  const emptyStore = join(root, "new.db");
  expect(Bun.spawnSync([bin, "audit", artifact, "--quiet"], { cwd: root, env: { ...env, AGENTOPS_DB: emptyStore } }).exitCode).toBe(0);
  const db = openStore(emptyStore);
  try { expect(getSessionCommits(db, "twice").map((c) => c.sha)).toEqual([full]); }
  finally { db.db.close(); }

});
test("look in an enrolled linked checkout uses the recorder store by default", () => {
  hook("lookup", "SessionEnd");
  for (const cwd of [linked, repo]) {
    const r = Bun.spawnSync([bin, "look", "lookup"], { cwd, env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("lookup");
  }
  expect(existsSync(join(linked, ".agentops", "agentops.db"))).toBe(false);
});
test("raw audits preserve distinct paths for sibling working directories", () => {
  const artifact = join(root, "raw.jsonl");
  const records = ["src", "test"].map((dir) => {
    const cwd = join(linked, dir);
    mkdirSync(cwd);
    return { hook_event_name: "PostToolUse", session_id: "raw", cwd, tool_name: "Write",
      tool_input: { file_path: join(cwd, "a.ts") }, tool_response: { type: "create" } };
  });
  writeFileSync(artifact, records.map((r) => JSON.stringify(r)).join("\n"));
  const r = Bun.spawnSync([bin, "audit", artifact, "--quiet"], { cwd: root, env: { ...env, AGENTOPS_DB: dbPath() } });
  expect(r.exitCode).toBe(0);
  const db = openStore(dbPath());
  try { expect(getFileChanges(db, "raw").map((f) => f.path).sort()).toEqual(["src/a.ts", "test/a.ts"]); }
  finally { db.db.close(); }
});
