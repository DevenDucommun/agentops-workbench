import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkChain } from "../src/eventChain";
import { redactString, sha256 } from "../src/redaction";
import { appendHookPayload, buildSpoolRecord, defaultSpoolDir, readSpool, spoolFileName, spoolPath } from "../src/recorder/spool";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "claude-hooks", `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const tempDir = () => join(mkdtempSync(join(tmpdir(), "agentops-spool-test-")), "spool");
const fixedClock = { now: () => new Date("2026-11-19T12:00:00.000Z") };

describe("buildSpoolRecord", () => {
  const commit = fixture("commit-session");
  const failing = fixture("failing-test-session");

  test("lifts identifiers, stamps receive time and drops transcript paths", () => {
    const post = commit.find((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Edit") as Record<string, unknown>;
    const record = buildSpoolRecord(post, fixedClock);
    expect(record).toMatchObject({
      schemaVersion: "agentops.event.v1",
      type: "claude_hook",
      source: "claude-code",
      timestamp: "2026-11-19T12:00:00.000Z",
      hookEventName: "PostToolUse",
      toolName: "Edit",
      toolUseId: post.tool_use_id,
      promptId: post.prompt_id,
      cwd: "/workspace/demo-repo"
    });
    expect(JSON.stringify(record)).not.toContain("transcript_path");
    const sub = fixture("subagent-session").find((e) => e.hook_event_name === "SubagentStop") as Record<string, unknown>;
    const subRecord = buildSpoolRecord(sub);
    expect(subRecord).toMatchObject({ agentId: "a0b1c2d3e4f5a6b7c", agentType: "Explore" });
    expect(JSON.stringify(subRecord)).not.toContain("agent_transcript_path");
  });

  test("stores file contents and command output as length + sha256 by default", () => {
    const bash = failing.find((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Bash") as Record<string, unknown>;
    const stdout = (bash.tool_response as { stdout: string }).stdout;
    const record = buildSpoolRecord(bash);
    expect((record.payload as { tool_response: { stdout: unknown } }).tool_response.stdout).toEqual({ omitted: "content", bytes: Buffer.byteLength(stdout), sha256: sha256(stdout) });
    expect((record.payload as { tool_input: { command: string } }).tool_input.command).toBe("bun test");

    const read = failing.find((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Read") as Record<string, unknown>;
    expect(JSON.stringify(buildSpoolRecord(read))).not.toContain("return a - b");

    const batch = failing.find((e) => e.hook_event_name === "PostToolBatch") as Record<string, unknown>;
    const calls = (buildSpoolRecord(batch).payload as { tool_calls: Array<{ tool_response: unknown }> }).tool_calls;
    expect(calls.every((c) => typeof c.tool_response === "object")).toBe(true);
  });

  test("keeps the exit code from a failure and hashes the failure output", () => {
    const failure = failing.find((e) => e.hook_event_name === "PostToolUseFailure") as Record<string, unknown>;
    const record = buildSpoolRecord(failure);
    expect(record.exitCode).toBe(1);
    expect((record.payload as { error: { omitted: string } }).error.omitted).toBe("content");
  });

  test("keeps prompts and assistant messages (redacted), which the evidence ledger needs", () => {
    const prompt = failing.find((e) => e.hook_event_name === "UserPromptSubmit") as Record<string, unknown>;
    expect((buildSpoolRecord(prompt).payload as { prompt: string }).prompt).toBe("Make the tests pass.");
    const stop = failing.find((e) => e.hook_event_name === "Stop") as Record<string, unknown>;
    expect((buildSpoolRecord(stop).payload as { last_assistant_message: string }).last_assistant_message).toContain("1 pass, 0 fail");
  });

  test("computes contentHash and added-line hashes for writes and edits", () => {
    const write = commit.find((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Write") as Record<string, unknown>;
    expect(buildSpoolRecord(write)).toMatchObject({
      contentHash: sha256("Fixed add to return the sum.\n"),
      addedLineHashes: [sha256("Fixed add to return the sum.")]
    });
    const edit = commit.find((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Edit") as Record<string, unknown>;
    expect(buildSpoolRecord(edit)).toMatchObject({
      contentHash: sha256("export function add(a, b) {\n  return a + b;\n}\n"),
      addedLineHashes: [sha256("  return a + b;")]
    });
  });

  test("storeRawPayload keeps contents, still redacted", () => {
    const bash = failing.find((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Bash") as Record<string, unknown>;
    const record = buildSpoolRecord(bash, { storeRawPayload: true });
    expect((record.payload as { tool_response: { stdout: string } }).tool_response.stdout).toContain("1 pass");
  });
});

describe("appendHookPayload", () => {
  test("chains a whole fixture session with continuous seq", () => {
    const dir = tempDir();
    const events = fixture("commit-session");
    for (const e of events) expect(appendHookPayload(dir, e).ok).toBe(true);
    const path = spoolPath(dir, events[0].session_id as string) as string;
    const { records, invalidLines } = readSpool(path);
    expect(invalidLines).toEqual([]);
    expect(records.map((r) => r.seq)).toEqual(events.map((_, i) => i + 1));
    expect(records[0].eventId).toBe(`${events[0].session_id}:1`);
    expect(checkChain(records)).toMatchObject({ status: "valid", count: events.length });
  });

  test("AC3: synthetic secrets never reach the spool in plaintext", () => {
    const dir = tempDir();
    const at = "@";
    const secrets = {
      aws: `AKIA${"Q".repeat(16)}`,
      github: `ghp_${"x1".repeat(15)}`,
      email: `someone${at}example.org`,
      home: `/${"Users"}/someone/private/notes.txt`
    };
    const sid = "0a1b2c3d-0009-4000-8000-000000000009";
    const base = { session_id: sid, cwd: secrets.home, prompt_id: "5e1f0a00-0009-4000-8000-0000000000a9" };
    appendHookPayload(dir, { ...base, hook_event_name: "UserPromptSubmit", prompt: `deploy with ${secrets.aws} and mail ${secrets.email}` });
    appendHookPayload(dir, { ...base, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: secrets.home, content: `TOKEN=${secrets.github}\n` }, tool_response: { type: "create", filePath: secrets.home, content: `TOKEN=${secrets.github}\n` } });
    appendHookPayload(dir, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `curl -H "token: ${secrets.github}" ${secrets.email}`, description: "x" }, tool_response: { stdout: secrets.aws, stderr: "" } });
    appendHookPayload(dir, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "env", description: "x" }, tool_response: { stdout: secrets.aws, stderr: "" } }, { storeRawPayload: true });

    const text = readFileSync(spoolPath(dir, sid) as string, "utf8");
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(text).toContain("[REDACTED:aws-access-key]");
    expect(redactString(secrets.home)).toBe("[REDACTED:local-path]");
    expect(checkChain(readSpool(spoolPath(dir, sid) as string).records).status).toBe("valid");
  });

  test("AC5: concurrent writers keep two sessions intact with continuous seq", async () => {
    const dir = tempDir();
    const sessions = { a: "0a1b2c3d-00aa-4000-8000-0000000000aa", b: "0a1b2c3d-00bb-4000-8000-0000000000bb" };
    const writer = join(import.meta.dir, "support", "spool-writer.ts");
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const procs = [
      ...["A1", "A2", "A3", "A4"].map((tag) => Bun.spawn(["bun", writer, dir, sessions.a, "40", tag], { env, stdout: "ignore", stderr: "inherit" })),
      ...["B1", "B2"].map((tag) => Bun.spawn(["bun", writer, dir, sessions.b, "40", tag], { env, stdout: "ignore", stderr: "inherit" }))
    ];
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0, 0]);

    for (const [sid, expected] of [[sessions.a, 160], [sessions.b, 80]] as const) {
      const { records, invalidLines } = readSpool(spoolPath(dir, sid) as string);
      expect(invalidLines).toEqual([]);
      expect(records.map((r) => r.seq)).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
      expect(checkChain(records)).toMatchObject({ status: "valid", count: expected });
      expect(new Set(records.map((r) => r.toolUseId)).size).toBe(expected);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".lock"))).toEqual([]);
  }, 60_000);

  test("resumes the chain after a torn last line from a crashed writer", () => {
    const dir = tempDir();
    const sid = "0a1b2c3d-000c-4000-8000-00000000000c";
    const payload = { session_id: sid, hook_event_name: "Stop", last_assistant_message: "done" };
    appendHookPayload(dir, payload);
    appendHookPayload(dir, payload);
    const path = spoolPath(dir, sid) as string;
    writeFileSync(path, `${readFileSync(path, "utf8")}{"schemaVersion":"agentops.event.v1","type":"claude_ho`);

    const result = appendHookPayload(dir, payload);
    expect(result).toMatchObject({ ok: true, seq: 3 });
    const { records, invalidLines } = readSpool(path);
    expect(invalidLines).toEqual([3]);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(checkChain(records).status).toBe("valid");
  });

  test("a torn first record still gets a line break, so the next records stay readable", () => {
    const dir = tempDir();
    const sid = "0a1b2c3d-000d-4000-8000-00000000000d";
    const payload = { session_id: sid, hook_event_name: "Stop", last_assistant_message: "done" };
    const path = spoolPath(dir, sid) as string;
    appendHookPayload(dir, payload);
    writeFileSync(path, '{"schemaVersion":"agentops.event.v1","type":"claude_ho');

    expect(appendHookPayload(dir, payload)).toMatchObject({ ok: true, seq: 1 });
    expect(appendHookPayload(dir, payload)).toMatchObject({ ok: true, seq: 2 });
    const { records, invalidLines } = readSpool(path);
    expect(invalidLines).toEqual([1]);
    expect(records.map((r) => r.seq)).toEqual([1, 2]);
    expect(checkChain(records).status).toBe("valid");
  });

  test("caps oversized records but keeps them chained", () => {
    const dir = tempDir();
    const sid = "0a1b2c3d-000d-4000-8000-00000000000d";
    const big = "y ".repeat(5000);
    const result = appendHookPayload(dir, { session_id: sid, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "cat big", description: "x" }, tool_response: { stdout: big } }, { storeRawPayload: true, maxRecordBytes: 2000 });
    expect(result).toMatchObject({ ok: true, truncated: true });
    const [record] = readSpool(spoolPath(dir, sid) as string).records;
    expect(record).toMatchObject({ truncated: true, toolName: "Bash", payload: { omitted: "payload" } });
    expect(JSON.stringify(record).length).toBeLessThan(2000);
    expect(checkChain([record]).status).toBe("valid");
  });
});

describe("AC4: failures never throw", () => {
  test("a payload without session_id is rejected", () => {
    expect(appendHookPayload(tempDir(), { hook_event_name: "Stop" })).toMatchObject({ ok: false, reason: "invalid-session" });
  });

  test.skipIf(process.getuid?.() === 0)("an unwritable spool directory returns ok: false", () => {
    const dir = tempDir();
    appendHookPayload(dir, { session_id: "s-unwritable", hook_event_name: "Stop" });
    chmodSync(dir, 0o500);
    try {
      expect(appendHookPayload(dir, { session_id: "s-unwritable-2", hook_event_name: "Stop" })).toMatchObject({ ok: false, reason: "write-failed" });
      expect(appendHookPayload(join(dir, "nested"), { session_id: "s-x", hook_event_name: "Stop" })).toMatchObject({ ok: false, reason: "write-failed" });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a held lock times out and leaves a recorder_error line", () => {
    const dir = tempDir();
    const sid = "0a1b2c3d-000e-4000-8000-00000000000e";
    appendHookPayload(dir, { session_id: sid, hook_event_name: "Stop" });
    const path = spoolPath(dir, sid) as string;
    writeFileSync(`${path}.lock`, "12345");
    expect(appendHookPayload(dir, { session_id: sid, hook_event_name: "Stop" }, { lockTimeoutMs: 20 })).toMatchObject({ ok: false, reason: "lock-timeout" });
    const errors = readFileSync(path.replace(/\.jsonl$/, ".errors.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(errors).toMatchObject([{ type: "agentops.recorder_error", reason: "lock-timeout" }]);
    expect(readSpool(path).records.length).toBe(1);
  });

  test("an abandoned lock is reclaimed", () => {
    const dir = tempDir();
    const sid = "0a1b2c3d-000f-4000-8000-00000000000f";
    appendHookPayload(dir, { session_id: sid, hook_event_name: "Stop" });
    const lock = `${spoolPath(dir, sid)}.lock`;
    writeFileSync(lock, "12345");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(appendHookPayload(dir, { session_id: sid, hook_event_name: "Stop" })).toMatchObject({ ok: true, seq: 2 });
    expect(existsSync(lock)).toBe(false);
  });
});

describe("paths", () => {
  test("unsafe session ids are hashed into the file name", () => {
    expect(spoolFileName("0a1b2c3d-0001-4000-8000-000000000001")).toBe("0a1b2c3d-0001-4000-8000-000000000001.jsonl");
    expect(spoolFileName("../../etc/passwd")).toMatch(/^sid-[0-9a-f]{32}\.jsonl$/);
    expect(spoolFileName("")).toBeNull();
    const dir = tempDir();
    expect(appendHookPayload(dir, { session_id: "../escape", hook_event_name: "Stop" }).ok).toBe(true);
    expect(readdirSync(dir).every((f) => f.startsWith("sid-"))).toBe(true);
  });

  test("the spool lives under the user state directory, never the repo", () => {
    expect(defaultSpoolDir({ AGENTOPS_STATE_DIR: "/state/agentops" })).toBe("/state/agentops/spool");
    expect(defaultSpoolDir({ XDG_STATE_HOME: "/xdg" })).toBe("/xdg/agentops/spool");
    expect(defaultSpoolDir({})).toMatch(/\/\.local\/state\/agentops\/spool$/);
  });
});
