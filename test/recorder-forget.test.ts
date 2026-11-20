import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runRecorderCommand } from "../src/recorder/command";
import { enrollRepository } from "../src/recorder/enrollment";
import { handleHook, ingestAfterSessionEnd } from "../src/recorder/hook";
import { appendHookPayload, readSpool, spoolPath } from "../src/recorder/spool";
import { getEventChain, getSessionCommits, openStore } from "../src/store";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "claude-hooks");

async function recordedRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentops-forget-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const stateDir = join(root, "state");
  enrollRepository(repo, stateDir);
  for (const name of ["clean-session", "commit-session"]) {
    for (const line of readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").trim().split("\n")) {
      const outcome = handleHook(undefined, line.replaceAll("/workspace/demo-repo", repo), { stateDir });
      await ingestAfterSessionEnd(outcome, stateDir);
    }
  }
  return { repo, stateDir, env: { PATH: "/usr/bin:/bin", AGENTOPS_STATE_DIR: stateDir } };
}

const CLEAN = "0a1b2c3d-0001-4000-8000-000000000001";
const COMMIT = "0a1b2c3d-0005-4000-8000-000000000005";

test("forget removes one session from the store and its spool files, and leaves the others", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spoolDir = join(stateDir, "spool");
  const spool = spoolPath(spoolDir, COMMIT) as string;
  writeFileSync(spool.replace(/\.jsonl$/, ".errors.jsonl"), "{}\n");
  expect(existsSync(spool)).toBe(true);

  const out = await runRecorderCommand(["forget", COMMIT], { cwd: repo, env });
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toContain(`session ${COMMIT}`);
  expect(out.stdout).toContain(spool);

  const store = openStore(join(repo, ".agentops", "agentops.db"));
  expect(store.db.query("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: CLEAN }]);
  expect(getEventChain(store, COMMIT)).toEqual([]);
  expect(getSessionCommits(store, COMMIT)).toEqual([]);
  expect(store.db.query("SELECT COUNT(*) AS n FROM commands WHERE session_id = $s").get({ $s: COMMIT })).toEqual({ n: 0 });
  expect(getEventChain(store, CLEAN).length).toBeGreaterThan(0);
  store.db.close();

  expect(existsSync(spool)).toBe(false);
  expect(existsSync(spool.replace(/\.jsonl$/, ".errors.jsonl"))).toBe(false);
  expect(existsSync(spoolPath(spoolDir, CLEAN) as string)).toBe(true);

  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).stdout).toBe(`Nothing recorded for session ${COMMIT}.\n`);
});

test("forget needs exactly one session id", async () => {
  const { repo, env } = await recordedRepo();
  expect(await runRecorderCommand(["forget"], { cwd: repo, env })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("agentops recorder forget <session-id>") });
  expect(await runRecorderCommand(["forget", "a", "b"], { cwd: repo, env })).toMatchObject({ exitCode: 1 });
});

test("forget never removes a live writer's lock: it waits, then deletes nothing", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spoolDir = join(stateDir, "spool");
  const spool = spoolPath(spoolDir, COMMIT) as string;
  const before = readSpool(spool).records.length;
  // A hook process is mid-append: it holds the session lock.
  writeFileSync(`${spool}.lock`, "12345");

  const out = await runRecorderCommand(["forget", COMMIT], { cwd: repo, env });
  expect(out.exitCode).toBe(1);
  expect(out.stderr).toContain("being recorded right now");
  expect(existsSync(`${spool}.lock`)).toBe(true);
  expect(readSpool(spool).records.length).toBe(before);
  const store = openStore(join(repo, ".agentops", "agentops.db"));
  expect(store.db.query("SELECT id FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ id: COMMIT });
  store.db.close();
}, 10_000);

test("forget reclaims an abandoned lock, and a later append starts a fresh chain", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spoolDir = join(stateDir, "spool");
  const spool = spoolPath(spoolDir, COMMIT) as string;
  writeFileSync(`${spool}.lock`, "12345");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${spool}.lock`, old, old);

  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(0);
  expect(existsSync(spool)).toBe(false);
  expect(existsSync(`${spool}.lock`)).toBe(false);

  expect(appendHookPayload(spoolDir, { session_id: COMMIT, hook_event_name: "Stop", last_assistant_message: "later" })).toMatchObject({ ok: true, seq: 1 });
  expect(readSpool(spool).records.map((r) => [r.seq, r.prevHash])).toEqual([[1, null]]);
});
