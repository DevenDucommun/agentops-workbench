import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { enrollRepository } from "../src/recorder/enrollment";
import { handleHook, verdictAfterStop } from "../src/recorder/hook";

// T1.6: optional turn-end verdict. Off by default; when on, a recorded Stop
// returns exactly one JSON line with a systemMessage and no decision field.

const FIXTURES = join(import.meta.dir, "..", "fixtures", "claude-hooks");

function setup(config?: Record<string, unknown>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-verdict-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  if (config) writeFileSync(join(repo, "agentops.config.json"), JSON.stringify(config));
  const stateDir = join(root, "state");
  enrollRepository(repo, stateDir);
  return { repo, stateDir };
}

/** Records every payload of a fixture in `repo` and returns the outcome of its last Stop. */
function recordUntilStop(name: string, repo: string, stateDir: string) {
  const lines = readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").trim().split("\n");
  let last: ReturnType<typeof handleHook> | undefined;
  for (const line of lines) {
    const outcome = handleHook(undefined, line.replaceAll("/workspace/demo-repo", repo), { stateDir });
    if (outcome.recorded && outcome.hookEventName === "Stop") last = outcome;
  }
  if (!last) throw new Error("fixture has no Stop");
  return last;
}

describe("verdictAfterStop", () => {
  test("is off by default: no config, or recorder.verdict not true", async () => {
    for (const config of [undefined, { recorder: { verdict: false } }, { recorder: { verdict: "yes" } }, { recorder: {} }]) {
      const { repo, stateDir } = setup(config);
      expect(await verdictAfterStop(recordUntilStop("failing-test-session", repo, stateDir), stateDir)).toBeNull();
      expect(existsSync(join(repo, ".agentops"))).toBe(false);
    }
  });

  test("when on, a passing session yields one systemMessage line and no decision", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const out = await verdictAfterStop(recordUntilStop("failing-test-session", repo, stateDir), stateDir);
    expect(out).not.toBeNull();
    expect(out).not.toContain("\n");
    const parsed = JSON.parse(out as string);
    expect(Object.keys(parsed)).toEqual(["systemMessage"]);
    expect(parsed.systemMessage).toMatch(/^agentops: passed: all quality gates passed \(agentops look 0a1b2c3d-0004-4000-8000-000000000004\)$/);
  });

  test("when on, a risky session says needs review and names the failed checks", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const out = await verdictAfterStop(recordUntilStop("risky-session", repo, stateDir), stateDir);
    const message = JSON.parse(out as string).systemMessage as string;
    expect(message.startsWith("agentops: needs review: ")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message).toContain("agentops look 0a1b2c3d-0002-4000-8000-000000000002");
  });

  test("only Stop produces a verdict", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const pre = handleHook(undefined, JSON.stringify({ session_id: "s-only-stop", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" } }), { stateDir });
    expect(await verdictAfterStop(pre, stateDir)).toBeNull();
    const subStop = handleHook(undefined, JSON.stringify({ session_id: "s-only-stop", cwd: repo, hook_event_name: "SubagentStop", agent_id: "a1", last_assistant_message: "done" }), { stateDir });
    expect(await verdictAfterStop(subStop, stateDir)).toBeNull();
  });

  test.skipIf(process.getuid?.() === 0)("a failure produces no output and an error line", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const outcome = recordUntilStop("clean-session", repo, stateDir);
    mkdirSync(join(repo, ".agentops"));
    chmodSync(join(repo, ".agentops"), 0o500);
    try {
      expect(await verdictAfterStop(outcome, stateDir)).toBeNull();
    } finally {
      chmodSync(join(repo, ".agentops"), 0o700);
    }
    const errors = readFileSync(join(stateDir, "spool", "0a1b2c3d-0001-4000-8000-000000000001.errors.jsonl"), "utf8");
    expect(errors).toContain("verdict-failed");
  });
});

describe("process entry", () => {
  const run = (input: string, stateDir: string) => {
    const r = Bun.spawnSync(["bun", "./src/main.ts", "hook", "Stop"], {
      stdin: new TextEncoder().encode(input),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGENTOPS_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe"
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const stop = (repo: string) => JSON.stringify({ session_id: "0a1b2c3d-0016-4000-8000-000000000016", cwd: repo, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done.", background_tasks: [], session_crons: [] });

  test("verdict on: exactly one JSON line on stdout, nothing on stderr, exit 0", () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const r = run(stop(repo), stateDir);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const lines = r.out.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(["systemMessage"]);
  });

  test("verdict off: no output at all, exit 0", () => {
    const { repo, stateDir } = setup();
    expect(run(stop(repo), stateDir)).toEqual({ code: 0, out: "", err: "" });
  });
});
