import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkChain } from "../src/eventChain";
import { runRecorderCommand } from "../src/recorder/command";
import { createHookDelivery } from "../src/recorder/delivery";
import { enrollRepository } from "../src/recorder/enrollment";
import { handleHook } from "../src/recorder/hook";
import { readSpool } from "../src/recorder/spool";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "recorder-delivery-")));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  const stateDir = join(root, "state");
  enrollRepository(repo, stateDir);
  const dir = join(stateDir, "spool");
  const sid = "retry-fixture";
  const path = join(dir, sid + ".jsonl");
  const input = JSON.stringify({ session_id: sid, cwd: repo, tool_name: "Bash", tool_response: { stdout: "private synthetic output" } });
  const delivery = () => createHookDelivery(dir, sid);
  const record = (ticket?: string) => handleHook("PostToolUse", input, { stateDir, deliveryTicket: ticket });
  return { repo, stateDir, dir, sid, path, input, delivery, record };
}

// Inject faults in the child only, at the actual write syscall. Keep production
// code free of test-only exits. The bounded-read check runs after the retry's
// original record has moved far from the end of the spool.
const child = `
  import { mock } from "bun:test";
  import fs from "node:fs";
  const [hook, stateDir, input, deliveryTicket, fault, spool] = process.argv.slice(1);
  const real = { ...fs };
  const reads = [];
  mock.module("node:fs", () => ({ ...real,
    readFileSync(...args) {
      if (fault === "bounded" && args[0] === spool) throw Error("whole-spool read");
      return real.readFileSync(...args);
    },
    readSync(...args) {
      if (fault === "bounded") reads.push({ size: args[3], at: args[4] });
      return real.readSync(...args);
    },
    writeSync(...args) {
      const appending = typeof args[1] === "string" && args[1].includes('"deliveryId"');
      if (appending && fault === "hold") {
        real.writeSync(1, "ready");
        if (real.readSync(0, Buffer.alloc(1)) !== 1) throw Error("missing release signal");
      }
      if (appending && fault === "before") process.kill(process.pid, "SIGKILL");
      if (appending && fault === "newline") {
        real.writeSync(args[0], args[1].slice(0, -1));
        process.kill(process.pid, "SIGKILL");
      }
      const n = real.writeSync(...args);
      if (appending && fault === "after") process.kill(process.pid, "SIGKILL");
      return n;
    }
  }));
  const { handleHook } = await import(hook);
  const result = handleHook("PostToolUse", input, { stateDir, deliveryTicket });
  if (!result.recorded) throw Error(JSON.stringify(result));
  if (fault === "bounded" && (reads.length !== 1 || reads[0].at !== 0 || reads[0].size > 4096)) throw Error(JSON.stringify(reads));
`;

function attempt(f: ReturnType<typeof fixture>, ticket: string, fault = "") {
  return Bun.spawn([process.execPath, "-e", child, join(import.meta.dir, "../src/recorder/hook.ts"), f.stateDir, f.input, ticket, fault, f.path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

for (const fault of ["before", "after", "newline"]) {
  test(`worker killed ${fault} append recovers immediately through the same ticket`, async () => {
    const f = fixture();
    const t = f.delivery();
    const worker = attempt(f, t.ticket, fault);
    await worker.exited;
    expect(worker.signalCode).toBe("SIGKILL");
    expect(readSpool(f.path).records.length).toBe(fault === "before" ? 0 : 1);
    expect(existsSync(f.path + ".lock")).toBe(true);
    expect(f.record(t.ticket)).toMatchObject({ recorded: true, seq: 1 });
    expect(f.record(t.ticket)).toMatchObject({ recorded: true, seq: 1 });
    expect(checkChain(readSpool(f.path).records)).toMatchObject({ status: "valid", count: 1 });
    expect(existsSync(f.path + ".lock")).toBe(false);
    t.close();
  });
}

test("concurrent retries share a record, independent identical calls survive, and delayed lookup reads one row", async () => {
  const f = fixture();
  const t = f.delivery();
  const workers = Array.from({ length: 8 }, () => attempt(f, t.ticket));
  for (const worker of workers) expect(await worker.exited).toBe(0);
  for (let i = 0; i < 300; i++) expect(f.record()).toMatchObject({ recorded: true, seq: i + 2 });
  const second = f.delivery();
  expect(f.record(second.ticket)).toMatchObject({ recorded: true, seq: 302 });
  const retry = attempt(f, t.ticket, "bounded");
  expect(await retry.exited).toBe(0);
  const rows = readSpool(f.path).records;
  expect(checkChain(rows)).toMatchObject({ status: "valid", count: 302 });
  expect(rows[0].deliveryId).not.toBe(rows.at(-1)?.deliveryId);
  expect(readFileSync(f.path, "utf8")).not.toContain("private synthetic output");
  t.close();
  second.close();
  expect(existsSync(join(f.dir, t.ticket))).toBe(false);
});

test("retry respects a legacy writer and cannot recreate a forgotten session after re-enrollment", async () => {
  const f = fixture();
  const t = f.delivery();
  writeFileSync(f.path + ".lock", String(process.pid));
  expect(f.record(t.ticket)).toMatchObject({ recorded: false });
  expect(readFileSync(f.path + ".lock", "utf8")).toBe(String(process.pid));
  rmSync(f.path + ".lock");
  expect(f.record(t.ticket)).toMatchObject({ recorded: true, seq: 1 });
  const cmd = (args: string[]) => runRecorderCommand(args, { cwd: f.repo, env: { AGENTOPS_STATE_DIR: f.stateDir } });
  expect((await cmd(["forget", f.sid])).exitCode).toBe(0);
  expect(f.record(t.ticket)).toMatchObject({ recorded: false });
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(join(f.dir, f.sid + ".errors.jsonl"))).toBe(false);
  expect((await cmd(["disable"])).exitCode).toBe(0);
  expect((await cmd(["enable"])).exitCode).toBe(0);
  expect(f.record()).toMatchObject({ recorded: true, seq: 1 });
  expect(f.record(t.ticket)).toMatchObject({ recorded: false });
  expect(checkChain(readSpool(f.path).records)).toMatchObject({ status: "valid", count: 1 });
  t.close();
});

test("ordinary writer and forget honor the lock held by a pending delivery", async () => {
  const f = fixture();
  const t = f.delivery();
  const worker = attempt(f, t.ticket, "hold");
  try {
    const ready = await worker.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toBe("ready");
    expect(f.record()).toMatchObject({ recorded: false, reason: "append-failed" });
    const result = await runRecorderCommand(["forget", f.sid], { cwd: f.repo, env: { AGENTOPS_STATE_DIR: f.stateDir } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("being recorded");
    worker.stdin.write("x");
    worker.stdin.end();
    expect(await worker.exited).toBe(0);
    expect(f.record()).toMatchObject({ recorded: true, seq: 2 });
    expect(checkChain(readSpool(f.path).records)).toMatchObject({ status: "valid", count: 2 });
  } finally {
    worker.kill();
    await worker.exited;
    t.close();
  }
});
