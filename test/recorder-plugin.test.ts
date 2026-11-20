import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PLUGIN_INSTALL, runRecorderCommand } from "../src/recorder/command";
import { enrolledRepository } from "../src/recorder/enrollment";

const ROOT = join(import.meta.dir, "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

// The events spike S1 recommends registering.
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"];

describe("plugin packaging", () => {
  test("marketplace manifest lists agentops-recorder from ./plugin", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(marketplace).toMatchObject({ name: "agentops-workbench", owner: { name: expect.any(String) } });
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "agentops-recorder", source: "./plugin" })]);
    expect(PLUGIN_INSTALL).toBe("/plugin install agentops-recorder --marketplace DevenDucommun/agentops-workbench");
  });

  test("plugin manifest names the plugin and hooks.json registers one command per recorded event", () => {
    expect(readJson("plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "agentops-recorder", license: "MIT" });
    const { hooks } = readJson("plugin/hooks/hooks.json");
    expect(Object.keys(hooks)).toEqual(EVENTS);
    for (const event of EVENTS) {
      expect(hooks[event]).toEqual([{ matcher: "", hooks: [{ type: "command", command: expect.stringContaining(` hook ${event};`) }] }]);
    }
  });

  const command = (event: string) => readJson("plugin/hooks/hooks.json").hooks[event][0].hooks[0].command as string;
  const sh = (cmd: string, env: Record<string, string>, stdin = "{}") => {
    const r = Bun.spawnSync(["sh", "-c", cmd], { env: { PATH: "/usr/bin:/bin", ...env }, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("a hook command exits 0 silently when the agentops binary is missing", () => {
    for (const event of EVENTS) {
      expect(sh(command(event), { AGENTOPS_BIN: "agentops-binary-that-does-not-exist" })).toEqual({ code: 0, out: "", err: "" });
      expect(sh(command(event), {})).toEqual({ code: 0, out: "", err: "" });
    }
  });

  test("a hook command runs the binary with its event name and passes stdin and stdout through", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-plugin-cmd-"));
    const fake = join(dir, "fake-agentops");
    writeFileSync(fake, '#!/bin/sh\nprintf "args=%s %s stdin=" "$1" "$2"\ncat\n');
    chmodSync(fake, 0o755);
    expect(sh(command("Stop"), { AGENTOPS_BIN: fake }, '{"x":1}')).toEqual({ code: 0, out: 'args=hook Stop stdin={"x":1}', err: "" });
  });
});

describe("agentops recorder", () => {
  function repo() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-recorder-cmd-")));
    const dir = join(root, "repo");
    mkdirSync(join(dir, "src"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", dir]);
    return { dir, env: { PATH: "/usr/bin:/bin", AGENTOPS_STATE_DIR: join(root, "state") } };
  }

  test("enable, status and disable round-trip, from a subdirectory too", async () => {
    const { dir, env } = repo();
    const off = await runRecorderCommand(["status"], { cwd: dir, env });
    expect(off.stdout).toContain("Recorder: disabled");
    expect(off.stdout).toContain("Recorded sessions in");

    const on = await runRecorderCommand(["enable"], { cwd: join(dir, "src"), env });
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toContain(`Recorder enabled for ${dir}.`);
    expect(on.stdout).toContain(PLUGIN_INSTALL);
    expect(on.stdout).toContain("agentops binary is not on PATH");
    expect(on.stdout).toContain(".agentops/ is not in .gitignore");
    expect(enrolledRepository(dir, env.AGENTOPS_STATE_DIR)).toBe(dir);
    expect((await runRecorderCommand(["status"], { cwd: dir, env })).stdout).toContain("Recorder: enabled");

    const disabled = await runRecorderCommand(["disable"], { cwd: dir, env });
    expect(disabled.stdout).toContain(`Recorder disabled for ${dir}.`);
    expect(enrolledRepository(dir, env.AGENTOPS_STATE_DIR)).toBeNull();
    expect((await runRecorderCommand(["disable"], { cwd: dir, env })).stdout).toContain("was not enabled");
  });

  test("enable skips the warnings when the binary is on PATH and .agentops/ is ignored", async () => {
    const { dir, env } = repo();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.agentops/\n");
    const bin = mkdtempSync(join(tmpdir(), "agentops-bin-"));
    writeFileSync(join(bin, "agentops"), "#!/bin/sh\n");
    chmodSync(join(bin, "agentops"), 0o755);
    const out = await runRecorderCommand(["enable"], { cwd: dir, env: { ...env, PATH: `${bin}:/usr/bin:/bin` } });
    expect(out.stdout).not.toContain("Warning");
  });

  test("usage errors and non-repositories exit 1", async () => {
    const { env } = repo();
    expect(await runRecorderCommand([], { env })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Usage: agentops recorder") });
    expect(await runRecorderCommand(["bogus"], { env })).toMatchObject({ exitCode: 1 });
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "agentops-not-repo-")));
    expect(await runRecorderCommand(["enable"], { cwd: notRepo, env })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Not inside a git repository") });
  });

  // src/main.ts is the compiled binary's entry; bin/agentops is the package.json
  // bin used by source and PATH installs. Both must dispatch recorder and hook.
  for (const entry of [join("src", "main.ts"), join("bin", "agentops")]) {
    test(`${entry} dispatches recorder and hook`, () => {
      const { dir, env } = repo();
      const run = (args: string[], stdin = "") =>
        Bun.spawnSync([process.execPath, join(ROOT, entry), ...args], { cwd: dir, env: { ...env, HOME: process.env.HOME ?? "" }, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
      const status = run(["recorder", "status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toString()).toContain("Recorder: disabled");
      const hook = run(["hook", "Stop"], "{}");
      expect(hook.exitCode).toBe(0);
      expect(hook.stderr.toString()).toBe("");
    });
  }
});
