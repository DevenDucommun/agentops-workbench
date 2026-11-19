import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkChain } from "../src/eventChain";
import { enrolledRepository, enrollRepository, findRepositoryRoots, registryPath, unenrollRepository } from "../src/recorder/enrollment";
import { handleHook } from "../src/recorder/hook";
import { readSpool, spoolPath } from "../src/recorder/spool";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-hook-test-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  git(root, "init", "-q", repo);
  return { root, repo, stateDir: join(root, "state") };
}

const payload = (cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "0a1b2c3d-0014-4000-8000-000000000014", cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_01Synthetic0014N01000000", tool_input: { command: "bun test", description: "x" }, tool_response: { stdout: "1 pass", stderr: "" }, ...extra });

describe("enrollment", () => {
  test("finds the repository root from any subdirectory", () => {
    const { repo } = setup();
    expect(findRepositoryRoots(join(repo, "src", "deep"))).toEqual({ checkout: repo, main: repo });
    expect(findRepositoryRoots("relative/path")).toBeNull();
    expect(findRepositoryRoots(join(tmpdir(), "definitely-missing-dir-agentops"))).toBeNull();
  });

  test("enroll and unenroll are idempotent and live in the state dir, not the repo", () => {
    const { repo, stateDir } = setup();
    expect(enrolledRepository(repo, stateDir)).toBeNull();
    expect(enrollRepository(join(repo, "src"), stateDir)).toBe(repo);
    enrollRepository(repo, stateDir);
    expect(JSON.parse(readFileSync(registryPath(stateDir), "utf8")).repositories).toEqual([repo]);
    expect(existsSync(join(repo, ".agentops"))).toBe(false);
    expect(enrolledRepository(join(repo, "src", "deep"), stateDir)).toBe(repo);
    expect(unenrollRepository(repo, stateDir)).toBe(true);
    expect(unenrollRepository(repo, stateDir)).toBe(false);
    expect(enrolledRepository(repo, stateDir)).toBeNull();
  });

  test("a linked worktree of an enrolled repository is enrolled", () => {
    const { root, repo, stateDir } = setup();
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "init");
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", wt);
    expect(findRepositoryRoots(wt)).toEqual({ checkout: wt, main: repo });
    expect(enrolledRepository(wt, stateDir)).toBeNull();
    enrollRepository(repo, stateDir);
    expect(enrolledRepository(wt, stateDir)).toBe(repo);
  });

  test("a corrupt registry enrolls nothing", () => {
    const { repo, stateDir } = setup();
    mkdirSync(join(stateDir, "recorder"), { recursive: true });
    writeFileSync(registryPath(stateDir), "{not json");
    expect(enrolledRepository(repo, stateDir)).toBeNull();
    writeFileSync(registryPath(stateDir), JSON.stringify({ schemaVersion: "other", repositories: [repo] }));
    expect(enrolledRepository(repo, stateDir)).toBeNull();
  });
});

describe("handleHook", () => {
  test("AC2: an unenrolled repository records nothing", () => {
    const { repo, stateDir } = setup();
    expect(handleHook("PostToolUse", payload(repo), { stateDir })).toEqual({ recorded: false, reason: "not-enrolled" });
    expect(handleHook("PostToolUse", payload(tmpdir()), { stateDir })).toEqual({ recorded: false, reason: "not-enrolled" });
    expect(existsSync(join(stateDir, "spool"))).toBe(false);
  });

  test("malformed input is rejected without writing", () => {
    const { stateDir } = setup();
    for (const input of ["", "not json", "[1,2]", "null", "42"]) {
      expect(handleHook("Stop", input, { stateDir })).toMatchObject({ recorded: false, reason: "malformed-input" });
    }
    expect(existsSync(join(stateDir, "spool"))).toBe(false);
  });

  test("an enrolled repository records a chained spool, from a subdirectory too", () => {
    const { repo, stateDir } = setup();
    enrollRepository(repo, stateDir);
    expect(handleHook("PostToolUse", payload(repo), { stateDir })).toMatchObject({ recorded: true, seq: 1, repository: repo, hookEventName: "PostToolUse" });
    expect(handleHook("PostToolUse", payload(join(repo, "src")), { stateDir })).toMatchObject({ recorded: true, seq: 2 });
    const { records } = readSpool(spoolPath(join(stateDir, "spool"), "0a1b2c3d-0014-4000-8000-000000000014") as string);
    expect(checkChain(records)).toMatchObject({ status: "valid", count: 2 });
    expect((records[0].payload as { tool_response: { stdout: unknown } }).tool_response.stdout).toMatchObject({ omitted: "content" });
  });

  test("the event argument fills a missing hook_event_name; the payload's own name wins", () => {
    const { repo, stateDir } = setup();
    enrollRepository(repo, stateDir);
    handleHook("SessionEnd", JSON.stringify({ session_id: "s-arg", cwd: repo, reason: "other" }), { stateDir });
    handleHook("SessionEnd", JSON.stringify({ session_id: "s-arg", cwd: repo, hook_event_name: "Stop" }), { stateDir });
    const { records } = readSpool(spoolPath(join(stateDir, "spool"), "s-arg") as string);
    expect(records.map((r) => r.hookEventName)).toEqual(["SessionEnd", "Stop"]);
  });

  test("privacy.storeRawPayload in agentops.config.json keeps raw content", () => {
    const { repo, stateDir } = setup();
    enrollRepository(repo, stateDir);
    writeFileSync(join(repo, "agentops.config.json"), JSON.stringify({ privacy: { storeRawPayload: true } }));
    handleHook("PostToolUse", payload(repo), { stateDir });
    const { records } = readSpool(spoolPath(join(stateDir, "spool"), "0a1b2c3d-0014-4000-8000-000000000014") as string);
    expect((records[0].payload as { tool_response: { stdout: unknown } }).tool_response.stdout).toBe("1 pass");
  });

  test.skipIf(process.getuid?.() === 0)("an unwritable state directory reports append-failed and does not throw", () => {
    const { repo, stateDir } = setup();
    enrollRepository(repo, stateDir);
    mkdirSync(join(stateDir, "spool"), { recursive: true });
    chmodSync(join(stateDir, "spool"), 0o500);
    try {
      expect(handleHook("PostToolUse", payload(repo), { stateDir })).toMatchObject({ recorded: false, reason: "append-failed" });
    } finally {
      chmodSync(join(stateDir, "spool"), 0o700);
    }
  });
});

describe("process entry", () => {
  const run = (entry: string, input: string, stateDir: string) => {
    const r = Bun.spawnSync(["bun", entry, "hook", "PostToolUse"], {
      stdin: new TextEncoder().encode(input),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGENTOPS_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe"
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  // Hooks call the release binary (built from src/main.ts) or `bun run agentops`, which also uses src/main.ts.
  for (const entry of ["./src/main.ts"]) {
    test(`${entry} hook always exits 0 and prints nothing`, () => {
      const { repo, stateDir } = setup();
      enrollRepository(repo, stateDir);
      for (const input of [payload(repo), "", "garbage", payload(tmpdir())]) {
        expect(run(entry, input, stateDir)).toEqual({ code: 0, out: "", err: "" });
      }
      expect(readSpool(spoolPath(join(stateDir, "spool"), "0a1b2c3d-0014-4000-8000-000000000014") as string).records.length).toBe(1);
    });
  }
});
