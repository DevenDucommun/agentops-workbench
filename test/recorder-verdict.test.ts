import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { enrollRepository } from "../src/recorder/enrollment";
import { handleHook, verdictAfterStop, verdictJson } from "../src/recorder/hook";

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

  test("an invalid config is reported, never a pass", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true }, gates: { requiredVerificationCommands: "bun test" } });
    const out = await verdictAfterStop(recordUntilStop("clean-session", repo, stateDir), stateDir);
    const parsed = JSON.parse(out as string);
    expect(Object.keys(parsed)).toEqual(["systemMessage"]);
    expect(parsed.systemMessage).toMatch(/^agentops: needs review: invalid agentops\.config\.json: .*requiredVerificationCommands/);
    expect(parsed.systemMessage).toContain("agentops check");
    expect(parsed.systemMessage).not.toContain("passed");
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

describe("review 6001087386: the verdict matches agentops check in the session's checkout", () => {
  test("with AGENTOPS_DB set, the verdict ingests into and reads the configured store", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const out = await verdictAfterStop(recordUntilStop("clean-session", repo, stateDir), stateDir, { AGENTOPS_DB: "custom/agentops.db" });
    expect(out).not.toBeNull();
    expect(existsSync(join(repo, "custom", "agentops.db"))).toBe(true);
    expect(existsSync(join(repo, ".agentops", "agentops.db"))).toBe(false);
  });

  test("in a linked worktree, the worktree's own config decides and gates the verdict", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const worktree = join(repo, "..", "wt");
    git("worktree", "add", "-q", worktree);

    writeFileSync(join(worktree, "agentops.config.json"), JSON.stringify({ recorder: { verdict: false } }));
    expect(await verdictAfterStop(recordUntilStop("clean-session", worktree, stateDir), stateDir, {})).toBeNull();

    writeFileSync(join(worktree, "agentops.config.json"), JSON.stringify({ recorder: { verdict: true }, gates: { requiredVerificationCommands: ["make lint"] } }));
    const out = await verdictAfterStop(recordUntilStop("clean-session", worktree, stateDir), stateDir, {});
    expect(JSON.parse(out ?? "{}").systemMessage).toStartWith("agentops: needs review:");
    // The session lands in the shared store that `agentops look` and `check` read, not a worktree-local one.
    expect(existsSync(join(repo, ".agentops", "agentops.db"))).toBe(true);
    expect(existsSync(join(worktree, ".agentops", "agentops.db"))).toBe(false);
  });

  test("the whole JSON line stays within 300 characters, escapes included", () => {
    const message = `agentops: needs review: ${'requires "make lint" '.repeat(30)}`;
    const line = verdictJson(message);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(Object.keys(JSON.parse(line))).toEqual(["systemMessage"]);
    expect(verdictJson("short")).toBe('{"systemMessage":"short"}');
  });
});

test("a relative AGENTOPS_DB resolves against the session's working directory, as agentops check does there", async () => {
  const { repo, stateDir } = setup({ recorder: { verdict: true } });
  const sub = join(repo, "packages", "app");
  mkdirSync(sub, { recursive: true });
  const out = await verdictAfterStop(recordUntilStop("clean-session", sub, stateDir), stateDir, { AGENTOPS_DB: "local.db" });
  expect(out).not.toBeNull();
  expect(existsSync(join(sub, "local.db"))).toBe(true);
  expect(existsSync(join(repo, "local.db"))).toBe(false);
});

describe("review 6001288692: the verdict equals agentops check run in the session's directory", () => {
  test("a package directory's own config gates the verdict, as check reads it there", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const pkg = join(repo, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "agentops.config.json"), JSON.stringify({ recorder: { verdict: true }, gates: { requiredVerificationCommands: ["make lint"] } }));
    const out = await verdictAfterStop(recordUntilStop("clean-session", pkg, stateDir), stateDir, {});
    expect(JSON.parse(out ?? "{}").systemMessage).toStartWith("agentops: needs review:");
  });

  test("a relative AGENTOPS_DB resolves against the real directory behind a symlinked working directory", async () => {
    const { repo, stateDir } = setup({ recorder: { verdict: true } });
    const real = join(repo, "pkgs", "real");
    mkdirSync(real, { recursive: true });
    const link = join(repo, "linked");
    Bun.spawnSync(["ln", "-s", join("pkgs", "real"), link]);
    const out = await verdictAfterStop(recordUntilStop("clean-session", link, stateDir), stateDir, { AGENTOPS_DB: "../data/session.db" });
    expect(out).not.toBeNull();
    // A process in the linked directory resolves ../ from its real path, pkgs/real.
    expect(existsSync(join(repo, "pkgs", "data", "session.db"))).toBe(true);
    expect(existsSync(join(repo, "data", "session.db"))).toBe(false);
  });
});

test("an explicitly empty AGENTOPS_DB never yields a verdict, as agentops check cannot open a store there either", async () => {
  const { repo, stateDir } = setup({ recorder: { verdict: true } });
  expect(await verdictAfterStop(recordUntilStop("clean-session", repo, stateDir), stateDir, { AGENTOPS_DB: "" })).toBeNull();
  expect(existsSync(join(repo, ".agentops", "agentops.db"))).toBe(false);
});
