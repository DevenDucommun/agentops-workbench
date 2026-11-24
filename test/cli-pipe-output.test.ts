import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("a piped JSON gate report matches regular-file output and preserves its failing exit status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-pipe-"));
  const run = { cwd: dir, env: { ...process.env, AGENTOPS_DB: join(dir, "agentops.db") } };
  const cli = [process.execPath, resolve("bin/agentops")];
  try {
    const audit = Bun.spawnSync([...cli, "audit", resolve("fixtures/codex-session.jsonl"), "--quiet"], run);
    expect(audit.exitCode).toBe(0);
    const requiredVerificationCommands = Array.from({ length: 6000 }, (_, i) => `test-synthetic-${i}`);
    writeFileSync(join(dir, "agentops.config.json"), JSON.stringify({ gates: { requiredVerificationCommands } }));

    const command = [...cli, "check", "--json"];
    const saved = join(dir, "gate.json");
    const fd = openSync(saved, "w");
    try {
      expect(Bun.spawnSync(command, { ...run, stdout: fd }).exitCode).toBe(1);
    } finally {
      closeSync(fd);
    }
    const expected = readFileSync(saved);
    expect(expected.length).toBeGreaterThan(1024 * 1024);

    const child = Bun.spawn(command, { ...run, stdout: "pipe" });
    const actual = Buffer.from(await new Response(child.stdout).arrayBuffer());
    expect(await child.exited).toBe(1);
    expect(actual.length).toBe(expected.length);
    expect(actual.equals(expected)).toBe(true);
    expect(JSON.parse(actual.toString()).status).toBe("failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
