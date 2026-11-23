import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { detectAdapters, resolveAdapter } from "../src/adapters";
import { parseClaudeHooksJsonl } from "../src/claudeHooks";
import { runCli } from "../src/cli";
import { evaluateQualityGate } from "../src/gate";
import { defaultConfig } from "../src/config";
import { enrollRepository } from "../src/recorder/enrollment";
import { handleHook, ingestAfterSessionEnd, pushSource } from "../src/recorder/hook";
import { ingestSpoolFile, resolveCommit, storeHookTranscript } from "../src/recorder/ingest";
import { buildSpoolRecord, readSpool, spoolPath } from "../src/recorder/spool";
import { defaultStorePath, findSessionsForCommit, getEventChain, getEvents, getSessionCommits, getToolCalls, ingestTranscript, openStore } from "../src/store";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "claude-hooks");
const NAMES = ["clean-session", "risky-session", "subagent-session", "failing-test-session", "commit-session"];
const fixtureText = (name: string) => readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8");
const fixtureLines = (name: string) => fixtureText(name).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

describe("detection", () => {
  test("raw hook payloads and recorder spools resolve to claude-hooks", () => {
    for (const name of NAMES) {
      expect(resolveAdapter({ sourcePath: `${name}.jsonl`, content: fixtureText(name) }).id).toBe("claude-hooks");
    }
    const spool = fixtureLines("clean-session").map((p) => JSON.stringify(buildSpoolRecord(p))).join("\n");
    const ranked = detectAdapters({ sourcePath: "s.jsonl", content: spool }).filter((d) => d.detection.matched);
    expect(ranked[0].adapter.id).toBe("claude-hooks");
    expect(ranked.map((d) => d.adapter.id)).toContain("agentops-jsonl");
  });

  test("existing artifacts keep their adapters", () => {
    const expected: Record<string, string> = {
      "sample-session.jsonl": "agentops-jsonl",
      "claude-code-stream-current-session.jsonl": "claude-code-stream-json",
      "codex-exec-current-session.jsonl": "codex-exec-jsonl"
    };
    for (const [file, id] of Object.entries(expected)) {
      const content = readFileSync(join(import.meta.dir, "..", "fixtures", file), "utf8");
      expect(resolveAdapter({ sourcePath: file, content }).id).toBe(id);
    }
  });
});

describe("normalization", () => {
  test("one event per hook record, with chain fields and the right event types", () => {
    const { session, events } = parseClaudeHooksJsonl("commit-session.jsonl", fixtureText("commit-session"), defaultConfig);
    expect(session).toMatchObject({ id: "0a1b2c3d-0005-4000-8000-000000000005", source: "claude-code", sourceAdapter: "claude-hooks", task: "Fix add, add a notes file and commit." });
    expect(events.length).toBe(fixtureLines("commit-session").length);
    const types = events.map((e) => `${e.hookEventName}:${e.type}`);
    expect(types).toContain("PreToolUse:tool_started");
    expect(types).toContain("PostToolUse:file_edit");
    expect(types).toContain("PostToolUse:file_write");
    expect(types).toContain("Stop:final_response");
    const edit = events.find((e) => e.type === "file_edit");
    expect(edit).toMatchObject({ path: "math.js", linesAdded: 1, linesRemoved: 1, toolUseId: "toolu_01Synthetic0005N15000000" });
    expect(typeof edit?.contentHash).toBe("string");
    const commit = events.find((e) => e.gitCommit);
    expect(commit).toMatchObject({ command: 'git add -A && git -c user.name=demo -c user.email=demo commit -m "fix: add returns the sum"', exitCode: 0, gitCommit: { sha: "a1b2c3d", kind: "committed", branch: "main" } });
  });

  test("a matched start/finish pair counts as one tool call; an unmatched start still counts", () => {
    const store = openStore(join(realpathSync(mkdtempSync(join(tmpdir(), "agentops-toolcalls-"))), "a.db"));
    const lines = fixtureLines("commit-session");
    const transcript = parseClaudeHooksJsonl("commit-session.jsonl", fixtureText("commit-session"), defaultConfig);
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const finished = lines.filter((l) => l.hook_event_name === "PostToolUse" || l.hook_event_name === "PostToolUseFailure").length;
    const calls = getToolCalls(store, sessionId);
    expect(calls.reduce((n, c) => n + c.count, 0)).toBe(finished);
    expect(calls.every((c) => c.status !== null)).toBe(true);
    expect(getEvents(store, sessionId).filter((e) => e.type === "tool_started").length).toBeGreaterThan(0);

    const denied = { session_id: "0a1b2c3d-0099-4000-8000-000000000099", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_unmatched", tool_input: { command: "ls" } };
    const lone = parseClaudeHooksJsonl("lone.jsonl", `${JSON.stringify(denied)}\n`, defaultConfig);
    const loneId = ingestTranscript(store, lone, defaultConfig).sessionId;
    expect(getToolCalls(store, loneId).map((c) => c.toolName)).toEqual(["Bash"]);
    store.db.close();
  });

  test("failures keep their exit code; successes are exit 0", () => {
    const { events } = parseClaudeHooksJsonl("f.jsonl", fixtureText("failing-test-session"), defaultConfig);
    const runs = events.filter((e) => e.command === "bun test");
    expect(runs.map((e) => [e.status, e.exitCode])).toEqual([["failed", 1], ["completed", 0]]);
  });

  test("review 6026938504: an interrupted Bash failure stays interrupted even with an exit code", () => {
    const interrupted = { ...fixtureLines("failing-test-session").find((l) => l.hook_event_name === "PostToolUseFailure")! };
    interrupted.is_interrupt = true;
    interrupted.error = "Exit code 130\nInterrupted by user";
    const { events } = parseClaudeHooksJsonl("i.jsonl", `${JSON.stringify(interrupted)}\n`, defaultConfig);
    const run = events.find((e) => e.command === "bun test");
    expect([run?.status, run?.exitCode]).toEqual(["interrupted", 130]);
  });

  test("subagent events point at the Agent call that ran them", () => {
    const { events } = parseClaudeHooksJsonl("s.jsonl", fixtureText("subagent-session"), defaultConfig);
    const agentCall = events.find((e) => e.hookEventName === "PostToolUse" && e.toolName === "Agent");
    expect(agentCall).toMatchObject({ type: "tool_call", subagentId: "a0b1c2d3e4f5a6b7c" });
    const inside = events.filter((e) => e.agentId === "a0b1c2d3e4f5a6b7c");
    expect(inside.length).toBeGreaterThan(2);
    for (const e of inside) expect(e.parentToolUseId).toBe(agentCall?.toolUseId);
  });

  test("a torn last line is skipped", () => {
    const spool = `${fixtureLines("clean-session").map((p) => JSON.stringify(buildSpoolRecord(p))).join("\n")}\n{"schemaVersion":"agentops.event.v1","ty`;
    expect(parseClaudeHooksJsonl("t.jsonl", spool, defaultConfig).events.length).toBe(fixtureLines("clean-session").length);
  });
});

describe("spool path handling", () => {
  test("paths inside the repository are stored repo-relative, not redacted", () => {
    const home = `/${"Users"}/someone/code/app`;
    const record = buildSpoolRecord(
      { session_id: "s", cwd: `${home}/src`, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "toolu_x", tool_input: { file_path: `${home}/src/a.ts`, old_string: "a", new_string: "b" }, tool_response: { filePath: `${home}/src/a.ts`, structuredPatch: [{ lines: ["-a", "+b"] }] } },
      { repoRoots: [home] }
    );
    expect(record).toMatchObject({ path: "src/a.ts", cwd: "src", linesAdded: 1, linesRemoved: 1 });
    expect(JSON.stringify(record)).not.toContain("REDACTED:local-path");
    const outside = buildSpoolRecord({ session_id: "s", cwd: home, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: `/${"Users"}/someone/other.txt` } }, { repoRoots: [home] });
    expect(outside.path).toBe("[REDACTED:local-path]");
  });
});

describe("audit and look", () => {
  let dir: string;
  const previousDb = process.env.AGENTOPS_DB;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agentops-claude-hooks-cli-"));
    process.env.AGENTOPS_DB = join(dir, "agentops.db");
  });
  afterAll(() => {
    if (previousDb === undefined) delete process.env.AGENTOPS_DB;
    else process.env.AGENTOPS_DB = previousDb;
  });

  test("every T0.2 fixture ingests, and look shows its tool calls, files and commands", async () => {
    for (const name of NAMES) {
      const audit = await runCli(["audit", join(FIXTURES, `${name}.jsonl`), "--quiet"]);
      expect(audit.exitCode).toBe(0);
    }
    const look = await runCli(["look", "0a1b2c3d-0005-4000-8000-000000000005"]);
    expect(look.exitCode).toBe(0);
    expect(look.stdout).toContain("bun test");
    expect(look.stdout).toContain("math.js");
    expect(look.stdout).toContain("NOTES.md");
    expect(look.stdout).toMatch(/Bash/);
  });

  test("re-ingesting a session is idempotent", async () => {
    await runCli(["audit", join(FIXTURES, "clean-session.jsonl"), "--quiet"]);
    await runCli(["audit", join(FIXTURES, "clean-session.jsonl"), "--quiet"]);
    const store = openStore(process.env.AGENTOPS_DB);
    const rows = getEventChain(store, "0a1b2c3d-0001-4000-8000-000000000001");
    store.db.close();
    expect(rows.length).toBe(fixtureLines("clean-session").length);
    expect(rows.map((r) => r.seq)).toEqual(rows.map(() => null));
  });
});

describe("AC6: session-end ingest links the commit", () => {
  test("recording the commit fixture in an enrolled repo links the resolved full SHA", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-ac6-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(root, "init", "-q", repo);
    writeFileSync(join(repo, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "fix: add returns the sum");
    const full = git(repo, "rev-parse", "HEAD");
    const short = full.slice(0, 7);
    expect(resolveCommit(repo, short)).toBe(full);

    const stateDir = join(root, "state");
    enrollRepository(repo, stateDir);
    for (const payload of fixtureLines("commit-session")) {
      // Replace only the commit SHA: the fixture's session id also starts with "0a1b2c3d".
      const text = JSON.stringify(payload).replaceAll("/workspace/demo-repo", repo).replaceAll('"sha":"a1b2c3d"', `"sha":"${short}"`).replaceAll("main a1b2c3d", `main ${short}`);
      const outcome = handleHook(undefined, text, { stateDir });
      expect(outcome.recorded).toBe(true);
      await ingestAfterSessionEnd(outcome, stateDir);
    }

    const store = openStore(join(repo, ".agentops", "agentops.db"));
    const sid = "0a1b2c3d-0005-4000-8000-000000000005";
    const commits = getSessionCommits(store, sid);
    expect(commits).toEqual([{ sessionId: sid, sha: full, branch: "main", kind: "committed", source: "tool", eventId: expect.any(Number) }]);
    expect(findSessionsForCommit(store, short).map((c) => c.sessionId)).toEqual([sid]);
    const chain = getEventChain(store, sid);
    expect(chain.length).toBe(fixtureLines("commit-session").length);
    expect(chain.map((r) => r.seq)).toEqual(chain.map((_, i) => i + 1));
    const files = store.db.query("SELECT path FROM file_changes WHERE session_id = $sid ORDER BY path").all({ $sid: sid }) as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual(["NOTES.md", "math.js"]);
    const session = store.db.query("SELECT repo FROM sessions WHERE id = $sid").get({ $sid: sid }) as { repo: string };
    expect(session.repo).toBe("repo");
    store.db.close();

    const spoolFile = spoolPath(join(stateDir, "spool"), sid)!;
    const spool = readSpool(spoolFile);
    expect(JSON.stringify(spool.records)).not.toContain(repo);
    const priorDb = process.env.AGENTOPS_DB;
    process.env.AGENTOPS_DB = join(repo, ".agentops", "agentops.db");
    try {
      expect((await runCli(["audit", spoolFile, "--quiet"])).exitCode).toBe(0);
      const reopened = openStore();
      try {
        const [relinked] = getSessionCommits(reopened, sid);
        expect(relinked?.sha).toBe(full);
        expect(getEventChain(reopened, sid).find((e) => e.id === relinked?.eventId)?.eventUid)
          .toBe(chain.find((e) => e.id === commits[0]?.eventId)?.eventUid);
      } finally { reopened.db.close(); }
    } finally {
      if (priorDb === undefined) delete process.env.AGENTOPS_DB;
      else process.env.AGENTOPS_DB = priorDb;
    }
  });

  test("an unresolvable short SHA is linked as given", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-ac6-short-")));
    git(root, "init", "-q", root);
    const spoolFile = join(root, "spool.jsonl");
    writeFileSync(spoolFile, fixtureText("commit-session"));
    const result = ingestSpoolFile(spoolFile, { repoRoot: root, dbPath: join(root, "db.sqlite") });
    expect(result.commits.map((c) => c.sha)).toEqual(["a1b2c3d"]);
  });
});

describe("recorder review regressions", () => {
  test("detection and import recover the records following a torn first append", () => {
    const content = '{"typ\n' + fixtureLines("clean-session").map((p) => JSON.stringify(buildSpoolRecord(p))).join("\n");
    const input = { sourcePath: "interrupted.jsonl", content };
    expect(resolveAdapter(input).id).toBe("claude-hooks");
    expect(parseClaudeHooksJsonl(input.sourcePath, content, defaultConfig).events.length).toBe(fixtureLines("clean-session").length);
  });

  test("legacy paths are retained and failed edits do not produce a file-change row", () => {
    const records = ["PostToolUse", "PostToolUseFailure"].map((hookEvent, i) => {
      const r = buildSpoolRecord({ hook_event_name: hookEvent, session_id: "legacy", tool_name: "Edit",
        tool_input: { file_path: i ? ".env" : "src/old.ts" } });
      delete r.path;
      return JSON.stringify(r);
    });
    const transcript = parseClaudeHooksJsonl("legacy.jsonl", records.join("\n"), defaultConfig);
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-legacy-")), "store.db"));
    try {
      ingestTranscript(store, transcript, defaultConfig);
      expect(transcript.events.at(-1)).toMatchObject({ type: "tool_call", status: "failed", toolName: "Edit" });
      expect(store.db.query("SELECT path FROM file_changes").all()).toEqual([{ path: "src/old.ts" }]);
    } finally { store.db.close(); }
  });

  test("linked worktree capture uses its path and HEAD, honors the DB override and preserves links on audit", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-hook-review-")));
    const repo = join(root, "repo"), checkout = join(root, "linked"), stateDir = join(root, "state");
    git(root, "init", "-q", repo);
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "worktree", "add", "-qb", "topic", checkout);
    git(checkout, "commit", "--allow-empty", "-qm", "feature");
    const sha = git(checkout, "rev-parse", "HEAD");
    enrollRepository(repo, stateDir);
    const previous = process.env.AGENTOPS_DB;
    const db = join(root, "configured.db");
    process.env.AGENTOPS_DB = db;
    const sid = "linked";
    const emit = (event: string, fields: Record<string, unknown> = {}) => handleHook(event,
      JSON.stringify({ session_id: sid, cwd: checkout, hook_event_name: event, ...fields }), { stateDir });
    try {
      const push = { tool_name: "Bash", tool_input: { command: "git push origin HEAD" }, tool_response: { stdout: "", stderr: "" } };
      emit("PostToolUseFailure", { ...push, error: "Exit code 1" });
      emit("PostToolUse", push);
      emit("PostToolUse", { tool_name: "Edit", tool_input: { file_path: join(checkout, "src/a.ts") } });
      const outcome = emit("SessionEnd");
      await ingestAfterSessionEnd(outcome, stateDir);
      const file = spoolPath(join(stateDir, "spool"), sid)!;
      const store = openStore(db);
      try {
        const check = () => {
          expect(store.db.query("SELECT path FROM file_changes").all()).toEqual([{ path: "src/a.ts" }]);
          const commits = getSessionCommits(store, sid);
          expect(commits).toHaveLength(1);
          expect(commits[0]).toMatchObject({ sha, kind: "pushed", eventId: expect.any(Number) });
          expect(store.db.query("SELECT idx FROM events JOIN session_commits ON events.id = session_commits.event_id").all()).toEqual([{ idx: 2 }]);
        };
        check();
        expect((await runCli(["audit", file, "--quiet"])).exitCode).toBe(0);
        check();
      } finally { store.db.close(); }
    } finally {
      if (previous === undefined) delete process.env.AGENTOPS_DB;
      else process.env.AGENTOPS_DB = previous;
    }
  });
});

describe("recorder review regressions, round 3", () => {
  test("push capture resolves the refspec source and skips pushes with no single commit", () => {
    const cases: Array<[string, string | undefined]> = [
      ["git push", undefined],
      ["git push origin", undefined],
      ["git push -u origin HEAD", "HEAD"],
      ["git push -- origin HEAD:refs/heads/explicit", "HEAD"],
      ["git push -q origin HEAD:refs/heads/quiet", undefined],
      ["git push --quiet origin HEAD:refs/heads/quiet", undefined],
      ["git push --qui origin HEAD:refs/heads/quiet", undefined],
      ["git push origin HEAD:refs/heads/current", "HEAD"],
      ["git push origin other", "other"],
      ["git push origin +other:refs/heads/published", "other"],
      ["git push -o ci.skip origin other", "other"],
      ["git status --short && git push origin HEAD:refs/heads/current", "HEAD"],
      ["git push -nv origin HEAD:refs/heads/current", undefined],
      ["git push --dry-run origin", undefined],
      ["git push origin :refs/heads/gone", undefined],
      ["git push -d origin topic", undefined],
      ["git push --tags", undefined],
      ["git push origin a b", undefined],
      ["cd elsewhere && git push", undefined],
      ["git push; git push other", undefined],
      ["git push origin \"$(git branch --show-current)\"", undefined],
      ["git commit -m x", undefined]
    ];
    for (const [command, expected] of cases) expect([command, pushSource(command)]).toEqual([command, expected]);
  });

  test("re-importing a commit followed by its push keeps one canonical SHA from any directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-dup-sha-")));
    const repo = join(root, "repo");
    git(root, "init", "-q", repo);
    git(repo, "commit", "--allow-empty", "-qm", "work");
    const full = git(repo, "rev-parse", "HEAD");
    const bash = (command: string, response: Record<string, unknown>) =>
      buildSpoolRecord({ hook_event_name: "PostToolUse", session_id: "dup", cwd: repo, tool_name: "Bash", tool_input: { command }, tool_response: response });
    const push = bash("git push origin HEAD", { stdout: "", stderr: "" });
    push.gitCommit = { sha: full, kind: "pushed" };
    const lines = [bash("git commit -m work", { stdout: "", gitOperation: { commit: { sha: full.slice(0, 7), kind: "committed" } } }), push];
    const transcript = parseClaudeHooksJsonl("dup.jsonl", lines.map((r) => JSON.stringify(r)).join("\n"), defaultConfig);
    const store = openStore(join(root, "store.db"));
    try {
      storeHookTranscript(store, transcript, defaultConfig, repo);
      storeHookTranscript(store, transcript, defaultConfig, root);
      expect(getSessionCommits(store, "dup").map((c) => c.sha)).toEqual([full]);
    } finally { store.db.close(); }
  });

  test("the default store from a linked worktree is the main checkout's, where sessions are imported", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-default-db-")));
    const repo = join(root, "repo"), linked = join(root, "linked");
    git(root, "init", "-q", repo);
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "worktree", "add", "-qb", "topic", linked);
    const previous = process.env.AGENTOPS_DB;
    delete process.env.AGENTOPS_DB;
    try {
      expect(defaultStorePath(linked)).toBe(join(".agentops", "agentops.db"));
      openStore(join(repo, ".agentops", "agentops.db")).db.close();
      expect(defaultStorePath(linked)).toBe(join(repo, ".agentops", "agentops.db"));
      mkdirSync(join(repo, "sub"));
      expect(defaultStorePath(join(repo, "sub"))).toBe(join(repo, ".agentops", "agentops.db"));
    } finally {
      if (previous !== undefined) process.env.AGENTOPS_DB = previous;
    }
  });

  test("raw hook payloads keep paths relative to the checkout, not the event cwd", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-raw-cwd-")));
    const repo = join(root, "repo");
    git(root, "init", "-q", repo);
    for (const dir of ["src", "test"]) mkdirSync(join(repo, dir));
    const lines = ["src", "test"].map((dir) => JSON.stringify({ hook_event_name: "PostToolUse", session_id: "raw", cwd: join(repo, dir),
      tool_name: "Write", tool_input: { file_path: join(repo, dir, "a.ts"), content: "x" }, tool_response: { type: "create", filePath: join(repo, dir, "a.ts") } }));
    const transcript = parseClaudeHooksJsonl("raw.jsonl", lines.join("\n"), defaultConfig);
    expect(transcript.events.map((e) => e.path)).toEqual(["src/a.ts", "test/a.ts"]);
  });
});

test("Stop claims after the preview boundary still require verification", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-stop-")));
  const file = join(root, "test.jsonl");
  const dbPath = join(root, "store.db");
  const message = "Here are the details. ".repeat(8) + "All tests passed.";
  const records = [
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "bun run lint" }, tool_response: { exitCode: 0 } },
    { hook_event_name: "Stop", last_assistant_message: message }
  ].map((event) => JSON.stringify(buildSpoolRecord({ ...event, session_id: "late-claim" })));
  writeFileSync(file, records.join("\n"));
  ingestSpoolFile(file, { repoRoot: root, dbPath });
  const store = openStore(dbPath);
  try {
    expect(evaluateQualityGate(store, "late-claim").checks).toContainEqual(expect.objectContaining({ id: "unsupported-final-claims", status: "failed" }));
  } finally {
    store.db.close();
  }
});

test("an abbreviated dry run cannot link an unpublished commit", () => {
  expect(pushSource("git push --dry origin HEAD:refs/heads/unpublished")).toBeUndefined();
  expect(pushSource("git push --dry-r origin HEAD:refs/heads/unpublished")).toBeUndefined();
});

test("porcelain output identifies the configured source ref of an actual push", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-porcelain-")));
  const repo = join(root, "local");
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "-b", "trunk", repo);
  git(root, "init", "-q", "--bare", remote);
  git(repo, "commit", "--allow-empty", "-qm", "first");
  git(repo, "remote", "add", "fixture", remote);
  git(repo, "config", "remote.fixture.push", "refs/heads/trunk:refs/heads/published");
  const push = () => git(repo, "push", "--porcelain", "fixture");
  const detect = (output: string) => pushSource("git push --porcelain fixture", output);
  expect(detect(push())).toBe("refs/heads/trunk");
  expect(git(remote, "rev-parse", "published")).toBe(git(repo, "rev-parse", "trunk"));
  expect(detect(push())).toBeUndefined();
  git(repo, "commit", "--allow-empty", "-qm", "second");
  expect(detect(push())).toBe("refs/heads/trunk");
});

test("spools without a session id that share a file name stay separate, and replay stays idempotent", () => {
  const store = openStore(join(realpathSync(mkdtempSync(join(tmpdir(), "agentops-noid-"))), "a.db"));
  // A record capped for size can lose payload.session_id.
  const capped = (prompt: string) => {
    const record = buildSpoolRecord({ session_id: "s", cwd: "/workspace", hook_event_name: "UserPromptSubmit", prompt }, {}) as { payload?: Record<string, unknown> };
    delete record.payload?.session_id;
    return `${JSON.stringify(record)}\n`;
  };
  const first = capped("first capture");
  const second = capped("second capture");
  const ingest = (content: string) => ingestTranscript(store, parseClaudeHooksJsonl("capture.jsonl", content, defaultConfig), defaultConfig).sessionId;
  const a = ingest(first);
  const b = ingest(second);
  expect(a).not.toBe(b);
  expect(ingest(first)).toBe(a);
  expect(store.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
  store.db.close();
});

test("review 6027364583: a session-end import waits out a dashboard's read snapshot", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-reader-")));
  const dbPath = join(root, "store.db");
  const spool = (id: string) => {
    const file = join(root, `${id}.jsonl`);
    const records = [
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: { exitCode: 0 } },
      { hook_event_name: "Stop", last_assistant_message: "Done." }
    ].map((event) => JSON.stringify(buildSpoolRecord({ ...event, session_id: id })));
    writeFileSync(file, records.join("\n"));
    return file;
  };
  ingestSpoolFile(spool("session-a"), { repoRoot: root, dbPath });
  // Another process holds a read transaction for 350 ms, as the dashboard does
  // while building one session's evidence.
  const ready = join(root, "reader-ready");
  const reader = Bun.spawn([
    process.execPath,
    "-e",
    `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(dbPath)}); db.exec("BEGIN"); db.query("SELECT count(*) FROM sessions").get(); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "1"); Bun.sleepSync(350); db.exec("ROLLBACK"); db.close();`
  ]);
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(10);
  expect(existsSync(ready)).toBe(true);
  ingestSpoolFile(spool("session-b"), { repoRoot: root, dbPath });
  reader.kill();
  const store = openStore(dbPath);
  try {
    const ids = (store.db.query("SELECT id FROM sessions ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["session-a", "session-b"]);
  } finally {
    store.db.close();
  }
});

test("review 6027983530: the import waits from its first statement, migration included", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-writer-")));
  const dbPath = join(root, "store.db");
  const spool = (id: string) => {
    const file = join(root, `${id}.jsonl`);
    const records = [
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: { exitCode: 0 } },
      { hook_event_name: "Stop", last_assistant_message: "Done." }
    ].map((event) => JSON.stringify(buildSpoolRecord({ ...event, session_id: id })));
    writeFileSync(file, records.join("\n"));
    return file;
  };
  ingestSpoolFile(spool("first"), { repoRoot: root, dbPath });
  // Another process holds the write lock briefly, as a second session's import does.
  const ready = join(root, "writer-ready");
  const writer = Bun.spawn([
    process.execPath,
    "-e",
    `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(dbPath)}); db.exec("BEGIN EXCLUSIVE"); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "1"); Bun.sleepSync(300); db.exec("ROLLBACK"); db.close();`
  ]);
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(10);
  expect(existsSync(ready)).toBe(true);
  const started = Date.now();
  ingestSpoolFile(spool("second"), { repoRoot: root, dbPath });
  const elapsed = Date.now() - started;
  writer.kill();
  const store = openStore(dbPath);
  try {
    const ids = (store.db.query("SELECT id FROM sessions ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["first", "second"]);
  } finally {
    store.db.close();
  }
  expect(elapsed).toBeLessThan(1000);
});
