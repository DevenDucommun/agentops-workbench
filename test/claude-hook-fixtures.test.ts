import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Structural invariants of the synthetic Claude Code hook fixtures, taken from
// docs/specs/forensic-recorder/spike-s1.md (Claude Code 2.1.328 captures).
const dir = join(import.meta.dir, "..", "fixtures", "claude-hooks");
const names = ["clean-session", "risky-session", "subagent-session", "failing-test-session", "commit-session"];
type Ev = Record<string, unknown> & { hook_event_name: string };
const load = (name: string): Ev[] =>
  readFileSync(join(dir, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Ev);

const TOOL_USE_ID = /^toolu_[A-Za-z0-9]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.each(names)("%s", (name) => {
  const events = load(name);

  test("is one session with the common fields on every payload", () => {
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);
    for (const e of events) {
      expect(String(e.session_id)).toMatch(UUID);
      expect(typeof e.transcript_path).toBe("string");
      expect(typeof e.cwd).toBe("string");
      expect(typeof e.hook_event_name).toBe("string");
    }
  });

  test("opens with SessionStart and closes with SessionEnd", () => {
    expect(events[0].hook_event_name).toBe("SessionStart");
    expect(events.at(-1)?.hook_event_name).toBe("SessionEnd");
  });

  test("carries no timestamps (the spool writer adds receive time)", () => {
    for (const e of events) {
      expect(Object.keys(e).filter((k) => /time|^ts$|_at$/i.test(k))).toEqual([]);
    }
  });

  test("SessionStart has no prompt_id; later events do", () => {
    for (const e of events) {
      if (e.hook_event_name === "SessionStart") expect("prompt_id" in e).toBe(false);
      else expect(String(e.prompt_id)).toMatch(UUID);
    }
  });

  test("pairs every PreToolUse with exactly one PostToolUse or PostToolUseFailure", () => {
    const pre = events.filter((e) => e.hook_event_name === "PreToolUse");
    const post = events.filter((e) => e.hook_event_name === "PostToolUse" || e.hook_event_name === "PostToolUseFailure");
    expect(pre.length).toBe(post.length);
    for (const p of pre) {
      expect(String(p.tool_use_id)).toMatch(TOOL_USE_ID);
      const matches = post.filter((q) => q.tool_use_id === p.tool_use_id);
      expect(matches.length).toBe(1);
      expect(events.indexOf(matches[0])).toBeGreaterThan(events.indexOf(p));
    }
  });

  test("failures carry error and no tool_response", () => {
    for (const e of events.filter((x) => x.hook_event_name === "PostToolUseFailure")) {
      expect("tool_response" in e).toBe(false);
      expect(e.is_interrupt).toBe(false);
      if (e.tool_name === "Bash") expect(String(e.error)).toMatch(/^Exit code \d+\n/);
    }
  });

  test("tool, batch and stop events carry an effort object", () => {
    const withEffort = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "SubagentStop", "Stop"];
    for (const e of events.filter((x) => withEffort.includes(x.hook_event_name))) {
      expect(typeof (e.effort as { level?: unknown })?.level).toBe("string");
    }
  });

  test("PostToolBatch entries repeat per-tool calls with model-facing text", () => {
    const ids = new Set(events.filter((e) => e.hook_event_name === "PostToolUse" || e.hook_event_name === "PostToolUseFailure").map((e) => e.tool_use_id));
    for (const b of events.filter((e) => e.hook_event_name === "PostToolBatch")) {
      for (const call of b.tool_calls as Array<Record<string, unknown>>) {
        expect(ids.has(call.tool_use_id)).toBe(true);
        expect(typeof call.tool_response === "string" || Array.isArray(call.tool_response)).toBe(true);
      }
    }
  });
});

test("subagent-session links agent_id across SubagentStart, SubagentStop and the Agent result", () => {
  const events = load("subagent-session");
  const start = events.find((e) => e.hook_event_name === "SubagentStart");
  const stop = events.find((e) => e.hook_event_name === "SubagentStop");
  const pre = events.find((e) => e.hook_event_name === "PreToolUse" && e.tool_name === "Agent");
  const post = events.find((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Agent");
  if (!start || !stop || !pre || !post) throw new Error("subagent events missing");
  const agentId = String(start.agent_id);
  expect(agentId).toMatch(/^[0-9a-f]{17}$/);
  expect(stop.agent_id).toBe(agentId);
  expect((post.tool_response as { agentId: string }).agentId).toBe(agentId);
  expect("agent_id" in pre).toBe(false);
  expect("agent_id" in post).toBe(false);
  const inside = events.slice(events.indexOf(start), events.indexOf(stop) + 1);
  expect(inside.length).toBeGreaterThan(2);
  for (const e of inside) expect(e.agent_id).toBe(agentId);
  expect(String(stop.agent_transcript_path)).toBe(`${String(stop.transcript_path).replace(/\.jsonl$/, "")}/subagents/agent-${agentId}.jsonl`);
});

test("failing-test-session reports the failing run as PostToolUseFailure, then a passing run", () => {
  const runs = load("failing-test-session").filter((e) => e.tool_name === "Bash" && e.hook_event_name !== "PreToolUse");
  expect(runs.map((e) => e.hook_event_name)).toEqual(["PostToolUseFailure", "PostToolUse"]);
  expect(String(runs[0].error)).toContain(" 1 fail");
  expect(String((runs[1].tool_response as { stdout: string }).stdout)).toContain(" 0 fail");
});

test("commit-session reports a short commit SHA and resumes under the same session_id", () => {
  const events = load("commit-session");
  const commit = events.find((e) => (e.tool_response as { gitOperation?: unknown } | undefined)?.gitOperation);
  const op = (commit?.tool_response as { gitOperation: { commit: Record<string, string> } }).gitOperation.commit;
  expect(op.sha).toMatch(/^[0-9a-f]{7}$/);
  expect(op.kind).toBe("committed");
  const starts = events.filter((e) => e.hook_event_name === "SessionStart");
  expect(starts.map((e) => e.source)).toEqual(["startup", "resume"]);
  expect(typeof starts[1].seconds_since_last_response).toBe("number");
  expect(events.filter((e) => e.hook_event_name === "SessionEnd").length).toBe(2);
});

test("risky-session holds the risk patterns and a minified (no-whitespace) output", () => {
  const events = load("risky-session");
  const commands = events.filter((e) => e.hook_event_name === "PreToolUse" && e.tool_name === "Bash").map((e) => (e.tool_input as { command: string }).command);
  expect(commands).toContain("rm -rf ./dist");
  expect(commands.some((c) => c.includes("push --force"))).toBe(true);
  expect(events.some((e) => e.tool_name === "Write" && String((e.tool_input as { file_path: string }).file_path).endsWith("/.env"))).toBe(true);
  const longest = Math.max(
    ...events.map((e) => Math.max(0, ...String((e.tool_response as { stdout?: string } | undefined)?.stdout ?? "").split(/\s+/).map((t) => t.length))),
  );
  expect(longest).toBeGreaterThanOrEqual(60);
});
