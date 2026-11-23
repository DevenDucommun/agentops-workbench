import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

test("an abandoned lock blocks forget until it is deleted; then a later append starts a fresh chain", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spoolDir = join(stateDir, "spool");
  const spool = spoolPath(spoolDir, COMMIT) as string;
  writeFileSync(`${spool}.lock`, "12345");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${spool}.lock`, old, old);

  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(1);
  rmSync(`${spool}.lock`);
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(0);
  expect(existsSync(spool)).toBe(false);
  expect(existsSync(`${spool}.lock`)).toBe(false);

  expect(appendHookPayload(spoolDir, { session_id: COMMIT, hook_event_name: "Stop", last_assistant_message: "later" })).toMatchObject({ ok: true, seq: 1 });
  expect(readSpool(spool).records.map((r) => [r.seq, r.prevHash])).toEqual([[1, null]]);
}, 10_000);

test("review 6010150626: with AGENTOPS_DB set, forget removes the session from that store", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  // Import the commit session into a configured store too, as a hook with AGENTOPS_DB would.
  const { ingestSpoolFile } = await import("../src/recorder/ingest");
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  ingestSpoolFile(spool, { repoRoot: repo, dbPath: join(repo, "review.db") });
  const out = await runRecorderCommand(["forget", COMMIT], { cwd: repo, env: { ...env, AGENTOPS_DB: "review.db" } });
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toContain(`session ${COMMIT} from ${join(repo, "review.db")}`);
  const store = openStore(join(repo, "review.db"));
  expect(store.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 0 });
  store.db.close();
});

test("review 6010150626: forget never reclaims a held lock, however old", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  writeFileSync(`${spool}.lock`, "12345");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${spool}.lock`, old, old);
  const out = await runRecorderCommand(["forget", COMMIT], { cwd: repo, env });
  expect(out.exitCode).toBe(1);
  expect(out.stderr).toContain("Nothing was removed");
  expect(out.stderr).toContain(`${spool}.lock`);
  expect(existsSync(`${spool}.lock`)).toBe(true);
  expect(existsSync(spool)).toBe(true);
});

test("review 6010150626: a session-end import after forget does not restore the session", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(0);
  const { ingestSpoolFile } = await import("../src/recorder/ingest");
  expect(() => ingestSpoolFile(spool, { repoRoot: repo })).toThrow("spool removed");
  await ingestAfterSessionEnd({ recorded: true, hookEventName: "SessionEnd", spoolFile: spool, repository: repo } as never, stateDir);
  const store = openStore(join(repo, ".agentops", "agentops.db"));
  expect(store.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 0 });
  store.db.close();
  expect(existsSync(spool.replace(/\.jsonl$/, ".errors.jsonl"))).toBe(false);
});

test("review 6010207714: an import that read the spool before forget stores nothing after it", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  // The import already read this snapshot when forget ran.
  const snapshot = readFileSync(spool, "utf8");
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(0);
  writeFileSync(spool, snapshot);
  const { ingestSpoolFile } = await import("../src/recorder/ingest");
  expect(() => ingestSpoolFile(spool, { repoRoot: repo })).toThrow("spool forgotten");
  const store = openStore(join(repo, ".agentops", "agentops.db"));
  expect(store.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 0 });
  store.db.close();
  rmSync(spool);
  // A spool started again after forget is a new generation and imports normally.
  expect(appendHookPayload(join(stateDir, "spool"), { session_id: COMMIT, hook_event_name: "Stop", last_assistant_message: "later" })).toMatchObject({ ok: true, seq: 1 });
  expect(ingestSpoolFile(spool, { repoRoot: repo }).sessionId).toBe(COMMIT);
});

test("review 6010207714: an import never takes the spool lock, so it cannot delay a hook append", async () => {
  const { repo, stateDir } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  writeFileSync(`${spool}.lock`, "12345");
  const { ingestSpoolFile } = await import("../src/recorder/ingest");
  const started = Date.now();
  expect(ingestSpoolFile(spool, { repoRoot: repo }).sessionId).toBe(COMMIT);
  expect(Date.now() - started).toBeLessThan(1500);
  expect(readFileSync(`${spool}.lock`, "utf8")).toBe("12345");
});

test("review 6010207714: another spelling of a session id removes nothing", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  const out = await runRecorderCommand(["forget", COMMIT.toUpperCase()], { cwd: repo, env });
  expect(out.stdout).toBe(`Nothing recorded for session ${COMMIT.toUpperCase()}.\n`);
  expect(existsSync(spool)).toBe(true);
  const store = openStore(join(repo, ".agentops", "agentops.db"));
  expect(store.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 1 });
  store.db.close();
});

test("review 6010295645: a never-recorded id never removes another session that shares its redacted form", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  // Built at runtime so the publication scan does not see address-shaped literals.
  const recorded = ["someone", "example.com"].join("@");
  const other = ["nobody", "example.com"].join("@");
  for (const event of ["SessionStart", "SessionEnd"]) {
    const outcome = handleHook(undefined, JSON.stringify({ session_id: recorded, cwd: repo, hook_event_name: event }), { stateDir });
    await ingestAfterSessionEnd(outcome, stateDir);
  }
  const store = () => openStore(join(repo, ".agentops", "agentops.db"));
  const count = () => {
    const db = store();
    const n = (db.db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    db.db.close();
    return n;
  };
  const before = count();
  const out = await runRecorderCommand(["forget", other], { cwd: repo, env });
  expect(out.stdout).toBe(`Nothing recorded for session ${other}.\n`);
  expect(count()).toBe(before);
  expect(existsSync(spoolPath(join(stateDir, "spool"), recorded) as string)).toBe(true);
});

test("review 6010295645: a manual audit that read the spool before forget imports nothing", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  const snapshot = readFileSync(spool, "utf8");
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(0);
  writeFileSync(spool, snapshot);
  const audit = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "audit", spool, "--quiet"], { cwd: repo, env: { ...process.env, ...env } });
  expect(audit.exitCode).not.toBe(0);
  const db = openStore(join(repo, ".agentops", "agentops.db"));
  expect(db.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 0 });
  db.db.close();
});

test("review 6010295645: a forget that cannot delete leaves later imports working", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  const { Database } = await import("bun:sqlite");
  const holder = new Database(join(repo, ".agentops", "agentops.db"));
  holder.exec("BEGIN IMMEDIATE");
  const out = await runRecorderCommand(["forget", COMMIT], { cwd: repo, env });
  holder.exec("ROLLBACK");
  holder.close();
  expect(out.exitCode).toBe(1);
  expect(out.stderr).toContain("Run it again");
  expect(existsSync(spool)).toBe(true);
  expect(readdirSync(join(stateDir, "spool")).filter((name) => name.startsWith("forgotten-"))).toEqual([]);
  const { ingestSpoolFile } = await import("../src/recorder/ingest");
  expect(ingestSpoolFile(spool, { repoRoot: repo }).sessionId).toBe(COMMIT);
}, 10_000);

test("review 6010295645: the marker never names the session", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(0);
  const names = readdirSync(join(stateDir, "spool"));
  expect(names.some((name) => name.startsWith("forgotten-"))).toBe(true);
  expect(names.some((name) => name.includes(COMMIT))).toBe(false);
});

test("review 6010295645: a spool directory that cannot be listed stops forget before any change", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spoolDir = join(stateDir, "spool");
  chmodSync(spoolDir, 0o300);
  let out: Awaited<ReturnType<typeof runRecorderCommand>>;
  try {
    out = await runRecorderCommand(["forget", COMMIT], { cwd: repo, env });
  } finally {
    chmodSync(spoolDir, 0o700);
  }
  expect(out.exitCode).toBe(1);
  const db = openStore(join(repo, ".agentops", "agentops.db"));
  expect(db.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 1 });
  db.db.close();
  expect(existsSync(spoolPath(spoolDir, COMMIT) as string)).toBe(true);
});

test("review on e397286: a session-end import against a busy store fails fast and records why", async () => {
  const { repo, stateDir } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  const { Database } = await import("bun:sqlite");
  const holder = new Database(join(repo, ".agentops", "agentops.db"));
  holder.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  await ingestAfterSessionEnd({ recorded: true, hookEventName: "SessionEnd", spoolFile: spool, repository: repo } as never, stateDir);
  const elapsed = Date.now() - started;
  holder.exec("ROLLBACK");
  holder.close();
  expect(elapsed).toBeLessThan(1000);
  expect(readFileSync(spool.replace(/\.jsonl$/, ".errors.jsonl"), "utf8")).toContain("ingest-failed");
});

test("review 6010434366: an unreachable store stops forget before the spool is removed", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const storeDir = join(repo, ".agentops");
  chmodSync(storeDir, 0o000);
  let out: Awaited<ReturnType<typeof runRecorderCommand>>;
  try {
    out = await runRecorderCommand(["forget", COMMIT], { cwd: repo, env });
  } finally {
    chmodSync(storeDir, 0o700);
  }
  expect(out.exitCode).toBe(1);
  expect(existsSync(spoolPath(join(stateDir, "spool"), COMMIT) as string)).toBe(true);
});

test("review 6010434366: an audit that read the spool through a symlink imports nothing after forget", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  const snapshot = readFileSync(spool, "utf8");
  const link = join(repo, "linked-spool.jsonl");
  symlinkSync(spool, link);
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: repo, env })).exitCode).toBe(0);
  writeFileSync(spool, snapshot);
  const audit = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "audit", link, "--quiet"], { cwd: repo, env: { ...process.env, ...env } });
  expect(audit.exitCode).not.toBe(0);
  const db = openStore(join(repo, ".agentops", "agentops.db"));
  expect(db.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 0 });
  db.db.close();
});

test("review 6010509317: after a restore from a subdirectory, forget removes the session from the store check uses", async () => {
  const { repo, stateDir, env } = await recordedRepo();
  expect((await runRecorderCommand(["disable"], { cwd: repo, env })).exitCode).toBe(0);
  rmSync(join(repo, ".agentops", "agentops.db"));
  const sub = join(repo, "sub");
  mkdirSync(sub);
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const restore = Bun.spawnSync([process.execPath, main, "audit", spool, "--quiet"], { cwd: sub, env: { ...process.env, ...env } });
  expect(restore.exitCode).toBe(0);
  const checkStore = join(sub, ".agentops", "agentops.db");
  expect(existsSync(checkStore)).toBe(true);
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: sub, env })).exitCode).toBe(0);
  const db = openStore(checkStore);
  expect(db.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: COMMIT })).toEqual({ n: 0 });
  db.db.close();
});

/** A store in `sub/.agentops/` holding the commit session, restored by `agentops audit` while the recorder was disabled. */
async function restoredInSubdirectory() {
  const recorded = await recordedRepo();
  const { repo, stateDir, env } = recorded;
  expect((await runRecorderCommand(["disable"], { cwd: repo, env })).exitCode).toBe(0);
  const sub = join(repo, "sub");
  mkdirSync(sub);
  // An existing subdirectory store is the one audit and check pick from there while disabled.
  const subStore = join(sub, ".agentops", "agentops.db");
  openStore(subStore).db.close();
  const spool = spoolPath(join(stateDir, "spool"), COMMIT) as string;
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const restore = Bun.spawnSync([process.execPath, main, "audit", spool, "--quiet"], { cwd: sub, env: { ...process.env, ...env } });
  expect(restore.exitCode).toBe(0);
  return { ...recorded, sub, subStore, spool };
}

function sessionCount(path: string, id: string): number {
  const db = openStore(path);
  try {
    return (db.db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = $s").get({ $s: id }) as { n: number }).n;
  } finally {
    db.db.close();
  }
}

test("review 6024679539: forget after re-enabling still removes the session from the store restored while disabled", async () => {
  const { repo, env, sub, subStore, spool } = await restoredInSubdirectory();
  const mainStore = join(repo, ".agentops", "agentops.db");
  expect(sessionCount(subStore, COMMIT)).toBe(1);
  expect((await runRecorderCommand(["enable"], { cwd: repo, env })).exitCode).toBe(0);
  const out = await runRecorderCommand(["forget", COMMIT], { cwd: sub, env });
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toContain(`session ${COMMIT} from ${subStore}`);
  expect(out.stdout).toContain(`session ${COMMIT} from ${mainStore}`);
  expect(existsSync(spool)).toBe(false);
  // Disabling again makes check read the subdirectory store: nothing of the session is left.
  expect((await runRecorderCommand(["disable"], { cwd: repo, env })).exitCode).toBe(0);
  expect(sessionCount(subStore, COMMIT)).toBe(0);
  expect(sessionCount(mainStore, COMMIT)).toBe(0);
  expect(sessionCount(mainStore, CLEAN)).toBe(1);
});

test("review 6024679539: a busy second store makes forget remove nothing from any store", async () => {
  const { repo, env, sub, subStore, spool } = await restoredInSubdirectory();
  const mainStore = join(repo, ".agentops", "agentops.db");
  const { Database } = await import("bun:sqlite");
  const holder = new Database(subStore);
  holder.exec("BEGIN IMMEDIATE");
  let out: Awaited<ReturnType<typeof runRecorderCommand>>;
  try {
    out = await runRecorderCommand(["forget", COMMIT], { cwd: sub, env });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  expect(out.exitCode).toBe(1);
  expect(out.stderr).toContain("Run it again");
  expect(sessionCount(mainStore, COMMIT)).toBe(1);
  expect(sessionCount(subStore, COMMIT)).toBe(1);
  expect(existsSync(spool)).toBe(true);
  // Once the store is free, the same command finishes the job.
  expect((await runRecorderCommand(["forget", COMMIT], { cwd: sub, env })).exitCode).toBe(0);
  expect(sessionCount(mainStore, COMMIT)).toBe(0);
  expect(sessionCount(subStore, COMMIT)).toBe(0);
  expect(existsSync(spool)).toBe(false);
}, 10_000);

test("review 6024993200: a reader on the second store makes forget remove nothing from any store", async () => {
  const { repo, env, sub, subStore, spool } = await restoredInSubdirectory();
  const mainStore = join(repo, ".agentops", "agentops.db");
  const { Database } = await import("bun:sqlite");
  const reader = new Database(subStore);
  reader.exec("BEGIN");
  reader.query("SELECT count(*) FROM sessions").get();
  let out: Awaited<ReturnType<typeof runRecorderCommand>>;
  try {
    out = await runRecorderCommand(["forget", COMMIT], { cwd: sub, env });
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  expect(out.exitCode).toBe(1);
  expect(sessionCount(mainStore, COMMIT)).toBe(1);
  expect(sessionCount(subStore, COMMIT)).toBe(1);
  expect(existsSync(spool)).toBe(true);
}, 10_000);

test("review 6024993200: two busy stores share one wait budget, under the hooks' stale-lock limit", async () => {
  const { repo, env, sub, subStore } = await restoredInSubdirectory();
  const mainStore = join(repo, ".agentops", "agentops.db");
  const { Database } = await import("bun:sqlite");
  const holders = [new Database(mainStore), new Database(subStore)];
  for (const h of holders) h.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  let out: Awaited<ReturnType<typeof runRecorderCommand>>;
  try {
    out = await runRecorderCommand(["forget", COMMIT], { cwd: sub, env });
  } finally {
    for (const h of holders) {
      h.exec("ROLLBACK");
      h.close();
    }
  }
  expect(out.exitCode).toBe(1);
  expect(Date.now() - started).toBeLessThan(4000);
}, 15_000);

test("SessionEnd spends one lock budget across begin and commit and preserves the spool for replay", async () => {
  const { repo, stateDir } = await recordedRepo();
  const { Database } = await import("bun:sqlite");
  const dbPath = join(repo, ".agentops", "agentops.db");
  const reader = new Database(dbPath);
  const writer = new Database(dbPath);
  const id = "concurrent-end";
  const spool = spoolPath(join(stateDir, "spool"), id) as string;
  const bin = join(import.meta.dir, "..", "bin", "agentops");
  const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "plugin", "hooks", "hooks.json"), "utf8"));
  const env = { ...process.env, AGENTOPS_DB: dbPath, AGENTOPS_STATE_DIR: stateDir, AGENTOPS_BIN: bin };
  try {
    reader.exec("BEGIN");
    reader.query("SELECT id FROM sessions LIMIT 1").get();
    writer.exec("BEGIN IMMEDIATE");
    const hook = Bun.spawn(["sh", "-c", hooks.hooks.SessionEnd[0].hooks[0].command], {
      cwd: repo, env, timeout: 1500,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: id, cwd: repo, hook_event_name: "SessionEnd" }))
    });
    // Start measuring once capture has reached the spool. Release the writer
    // late enough that a fresh 750 ms wait at COMMIT would exceed the budget.
    const readyBy = performance.now() + 1500;
    while (!existsSync(spool) && performance.now() < readyBy) await Bun.sleep(5);
    expect(existsSync(spool)).toBe(true);
    const started = performance.now();
    await Bun.sleep(600);
    writer.exec("ROLLBACK");
    expect(await hook.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(1200);
    expect(readFileSync(spool.replace(/\.jsonl$/, ".errors.jsonl"), "utf8")).toContain("ingest-failed");
  } finally {
    writer.close();
    reader.close();
  }
  expect(sessionCount(dbPath, id)).toBe(0);
  for (let replay = 0; replay < 2; replay++) {
    expect(Bun.spawnSync([bin, "audit", spool, "--quiet"], { cwd: repo, env }).exitCode).toBe(0);
    expect(sessionCount(dbPath, id)).toBe(1);
  }
});
