import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { detectAdapters, resolveAdapter } from "../src/adapters";
import { parseClaudeHooksJsonl } from "../src/claudeHooks";
import { runCli } from "../src/cli";
import { defaultConfig } from "../src/config";
import { enrollRepository } from "../src/recorder/enrollment";
import { handleHook, ingestAfterSessionEnd } from "../src/recorder/hook";
import { ingestSpoolFile, resolveCommit } from "../src/recorder/ingest";
import { buildSpoolRecord, readSpool, spoolPath } from "../src/recorder/spool";
import { findSessionsForCommit, getEventChain, getSessionCommits, openStore } from "../src/store";

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

  test("failures keep their exit code; successes are exit 0", () => {
    const { events } = parseClaudeHooksJsonl("f.jsonl", fixtureText("failing-test-session"), defaultConfig);
    const runs = events.filter((e) => e.command === "bun test");
    expect(runs.map((e) => [e.status, e.exitCode])).toEqual([["failed", 1], ["completed", 0]]);
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
    store.db.close();

    const spool = readSpool(spoolPath(join(stateDir, "spool"), sid) as string);
    expect(JSON.stringify(spool.records)).not.toContain(repo);
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
