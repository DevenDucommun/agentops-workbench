import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig, validateConfigFile } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
import { parseJsonlTranscript } from "../src/parser";
import { parseClaudeCodeStreamJsonl } from "../src/claudeStream";
import { parseCodexExecJsonl } from "../src/codexExec";
import { detectStalls, normalizeCommand } from "../src/stalls";
import { getRiskFlags, ingestTranscript, openStore } from "../src/store";

const ROOT = join(import.meta.dir, "..");

function flagsFor(fixture: string, config = defaultConfig) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-stalls-")), "agentops.db"));
  const path = join(ROOT, fixture);
  const { sessionId } = ingestTranscript(store, parseJsonlTranscript(path, readFileSync(path, "utf8")), config);
  analyzeSession(store, sessionId, config);
  const flags = getRiskFlags(store, sessionId);
  const gate = evaluateQualityGate(store, sessionId, config, { gitChanges: [] });
  store.db.close();
  return { flags, gate };
}

const stallFlags = (flags: Array<{ category: string; severity: string; message: string }>) =>
  flags.filter((f) => f.category === "retry-without-change" || f.category === "repeated-edits").map((f) => `${f.severity}:${f.category}:${f.message}`);

describe("AC8: retry and stall fixtures", () => {
  test("a failing command re-run twice with no edit raises a medium retry flag", () => {
    expect(stallFlags(flagsFor("fixtures/stalls/retry-loop.jsonl").flags)).toEqual([
      "medium:retry-without-change:Command re-run 2 times after failing, with no file change in between: bun test test/parser.test.ts"
    ]);
  });

  test("a re-run after an edit is not a retry", () => {
    expect(stallFlags(flagsFor("fixtures/stalls/retry-after-edit.jsonl").flags)).toEqual([]);
  });

  test("one file changed six times raises repeated-edits at the default threshold", () => {
    expect(stallFlags(flagsFor("fixtures/stalls/repeated-edits.jsonl").flags)).toEqual(["medium:repeated-edits:src/parser.ts was changed 6 times in one session (threshold 6)."]);
  });

  test("the threshold is configurable", () => {
    const config = { ...defaultConfig, risk: { ...defaultConfig.risk, repeatedEditThreshold: 7 } };
    expect(stallFlags(flagsFor("fixtures/stalls/repeated-edits.jsonl", config).flags)).toEqual([]);
  });

  test("stall flags never change the gate: no high severity, not a claim category", () => {
    for (const name of ["retry-loop", "repeated-edits"]) {
      const { flags, gate } = flagsFor(`fixtures/stalls/${name}.jsonl`);
      expect(flags.filter((f) => f.category === "retry-without-change" || f.category === "repeated-edits").every((f) => f.severity !== "high")).toBe(true);
      expect(gate.checks.find((c) => c.id === "unsupported-final-claims")?.observed).toBe(0);
    }
  });
});

describe("detectStalls", () => {
  const cmd = (id: number, eventId: number | null, command: string, exitCode: number | null, status: string | null = exitCode === 0 ? "completed" : "failed") => ({ id, eventId, command, status, exitCode, output: null });
  const edit = (id: number, eventId: number | null, path: string) => ({ id, eventId, path, operation: "edit", linesAdded: 1, linesRemoved: 0 });
  const opts = { repeatedEditThreshold: 3 };

  test("one retry is low severity; leading and trailing whitespace is ignored", () => {
    const flags = detectStalls([cmd(1, 1, "  bun test\n", 1), cmd(2, 2, "bun test", 0)], [], opts);
    expect(flags.map((f) => [f.severity, f.category])).toEqual([["low", "retry-without-change"]]);
  });

  test("re-running a passing command, or a different command, is not a retry", () => {
    expect(detectStalls([cmd(1, 1, "bun test", 0), cmd(2, 2, "bun test", 0)], [], opts)).toEqual([]);
    expect(detectStalls([cmd(1, 1, "bun test", 1), cmd(2, 2, "bun run lint", 1)], [], opts)).toEqual([]);
  });

  test("runs that never executed are ignored", () => {
    expect(detectStalls([cmd(1, 1, "bun test", 1), cmd(2, 2, "bun test", null, "denied"), cmd(3, 3, "bun test", null, "started")], [], opts)).toEqual([]);
  });

  test("runs without event rows cannot be ordered against edits, so they are not retries", () => {
    expect(detectStalls([cmd(1, null, "bun test", 1), cmd(2, null, "bun test", 1)], [], opts)).toEqual([]);
  });

  test("internal whitespace is part of the command", () => {
    expect(normalizeCommand(`  bun   test  "test/a  b.test.ts"\t`)).toBe(`bun   test  "test/a  b.test.ts"`);
    expect(detectStalls([cmd(1, 1, "bun  test", 1), cmd(2, 2, "bun test", 1)], [], opts)).toEqual([]);
    expect(detectStalls([cmd(1, 1, `bun test "test/a  b.ts"`, 1), cmd(2, 2, `bun test "test/a b.ts"`, 1)], [], opts)).toEqual([]);
  });

  test("repeated edits are counted per file", () => {
    const flags = detectStalls([], [edit(1, 1, "a.ts"), edit(2, 2, "b.ts"), edit(3, 3, "a.ts"), edit(4, 4, "a.ts"), edit(5, 5, "b.ts")], opts);
    expect(flags.map((f) => f.message)).toEqual(["a.ts was changed 3 times in one session (threshold 3)."]);
    expect(flags[0].eventId).toBe(1);
  });
});

describe("Codex file changes", () => {
  const change = (type: "item.started" | "item.completed", id: string, status?: string) =>
    JSON.stringify({ type, item: { id, type: "file_change", ...(status ? { status } : {}), changes: [{ path: "src/a.ts", kind: "update" }] } });
  const repeated = (lines: string[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-stalls-")), "agentops.db"));
    const stream = [JSON.stringify({ type: "thread.started", thread_id: "codex-stalls" }), ...lines].join("\n");
    const { sessionId } = ingestTranscript(store, parseCodexExecJsonl("codex.jsonl", stream), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const categories = getRiskFlags(store, sessionId).map((f) => f.category);
    store.db.close();
    return categories.includes("repeated-edits");
  };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

  test("six failed file changes are not repeated edits", () => {
    expect(repeated(ids(6).map((id) => change("item.completed", id, "failed")))).toBe(false);
  });

  test("three edits reported as start and completion count three times, not six", () => {
    expect(repeated(ids(3).flatMap((id) => [change("item.started", id), change("item.completed", id, "completed")]))).toBe(false);
  });

  test("six completed edits are repeated edits", () => {
    expect(repeated(ids(6).map((id) => change("item.completed", id, "completed")))).toBe(true);
  });
});

describe("config", () => {
  test("risk.repeatedEditThreshold must be an integer of at least 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-stalls-config-"));
    const path = join(dir, "agentops.config.json");
    writeFileSync(path, JSON.stringify({ risk: { repeatedEditThreshold: 1 } }));
    expect(validateConfigFile(path).errors).toContain("risk.repeatedEditThreshold must be an integer of at least 2.");
  });
});

describe("review 6010139248: edit outcomes, run order, shell runs, argument boundaries", () => {
  const claude = (records: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-stalls-")), "agentops.db"));
    const text = records.map((record) => JSON.stringify(record)).join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", text), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const flags = stallFlags(getRiskFlags(store, sessionId));
    const files = (store.db.query("SELECT COUNT(*) AS n FROM file_changes WHERE session_id = $sid").get({ $sid: sessionId }) as { n: number }).n;
    store.db.close();
    return { flags, files };
  };
  const generic = (events: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-stalls-")), "agentops.db"));
    const text = [{ schemaVersion: "agentops.event.v1", type: "session", id: "stall-review" }, ...events].map((event) => JSON.stringify(event)).join("\n");
    const { sessionId } = ingestTranscript(store, parseJsonlTranscript("stall.jsonl", text), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const flags = stallFlags(getRiskFlags(store, sessionId));
    store.db.close();
    return flags;
  };
  const init = { type: "system", subtype: "init", session_id: "stall-claude" };
  const done = { type: "result", subtype: "success", session_id: "stall-claude", result: "Done." };
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, isError: boolean) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: isError ? "error" : "ok" }] } });

  test("failed Claude edits are not applied changes", () => {
    const records: unknown[] = [init];
    for (let i = 0; i < 6; i++) records.push(use(`e${i}`, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }), result(`e${i}`, true));
    const { flags, files } = claude([...records, done]);
    expect(files).toBe(0);
    expect(flags).toEqual([]);
  });

  test("a failed Claude edit does not separate a retry; a landed one does", () => {
    const run = (editFails: boolean) =>
      claude([
        init,
        use("b1", "Bash", { command: "bun test" }),
        result("b1", true),
        use("e1", "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
        result("e1", editFails),
        use("b2", "Bash", { command: "bun test" }),
        result("b2", false),
        done
      ]).flags;
    expect(run(true)).toEqual(["low:retry-without-change:Command re-run 1 time after failing, with no file change in between: bun test"]);
    expect(run(false)).toEqual([]);
  });

  test("identical Claude calls issued before the first result are not a retry", () => {
    const parallel = claude([
      init,
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test" } }, { type: "tool_use", id: "b2", name: "Bash", input: { command: "bun test" } }] } },
      result("b1", true),
      result("b2", false),
      done
    ]);
    expect(parallel.flags).toEqual([]);
    const sequential = claude([init, use("b1", "Bash", { command: "bun test" }), result("b1", true), use("b2", "Bash", { command: "bun test" }), result("b2", false), done]);
    expect(sequential.flags).toHaveLength(1);
  });

  test("overlapping Codex runs (start, start, fail, complete) are not a retry", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-stalls-")), "agentops.db"));
    const item = (id: string, status: string, exit: number | null) => ({ id, type: "command_execution", command: "bun test", aggregated_output: "", exit_code: exit, status });
    const lines = [
      { type: "thread.started", thread_id: "codex-overlap" },
      { type: "item.started", item: item("c1", "in_progress", null) },
      { type: "item.started", item: item("c2", "in_progress", null) },
      { type: "item.completed", item: item("c1", "failed", 1) },
      { type: "item.completed", item: item("c2", "completed", 0) }
    ];
    const { sessionId } = ingestTranscript(store, parseCodexExecJsonl("codex.jsonl", lines.map((line) => JSON.stringify(line)).join("\n")), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const flags = stallFlags(getRiskFlags(store, sessionId));
    store.db.close();
    expect(flags).toEqual([]);
  });

  test("only shell runs with an outcome count; a timeout is a failure", () => {
    const cmd = (extra: Record<string, unknown>) => ({ schemaVersion: "agentops.event.v1", type: "command", command: "bun test", ...extra });
    // A failed MCP lookup that carries a command input is not a shell run.
    expect(generic([{ schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "mcp__docs__search", command: "bun test", status: "failed" }, cmd({ exitCode: 0, status: "completed" })])).toEqual([]);
    // A rerun with no recorded result proves nothing.
    expect(generic([cmd({ exitCode: 1, status: "failed" }), cmd({ status: "no_result" })])).toEqual([]);
    // A timed-out run followed by a rerun is a retry.
    expect(generic([cmd({ status: "timed_out" }), cmd({ exitCode: 0, status: "completed" })])).toHaveLength(1);
  });

  test("an escaped quote or a newline keeps commands distinct", () => {
    expect(normalizeCommand('test -f "a\\" b"')).not.toBe(normalizeCommand('test -f "a\\"  b"'));
    expect(normalizeCommand("make\nclean")).not.toBe(normalizeCommand("make clean"));
    expect(normalizeCommand(" bun   test\t a.ts \n")).toBe("bun   test\t a.ts");
  });
});

describe("review round 5: applied edits, executed outcomes, exact commands", () => {
  const ingest = (records: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-stalls-")), "agentops.db"));
    const text = records.map((record) => JSON.stringify(record)).join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", text), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const flags = stallFlags(getRiskFlags(store, sessionId));
    const files = (store.db.query("SELECT COUNT(*) AS n FROM file_changes WHERE session_id = $sid").get({ $sid: sessionId }) as { n: number }).n;
    store.db.close();
    return { flags, files };
  };
  const generic = (events: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-stalls-")), "agentops.db"));
    const text = [{ schemaVersion: "agentops.event.v1", type: "session", id: "stall-r5" }, ...events].map((event) => JSON.stringify(event)).join("\n");
    const { sessionId } = ingestTranscript(store, parseJsonlTranscript("stall.jsonl", text), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const flags = stallFlags(getRiskFlags(store, sessionId));
    store.db.close();
    return flags;
  };
  const init = { type: "system", subtype: "init", session_id: "stall-r5" };
  const done = { type: "result", subtype: "success", session_id: "stall-r5", result: "Done." };
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, isError: boolean) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: isError ? "error" : "ok" }] } });
  const editInput = { file_path: "src/a.ts", old_string: "a", new_string: "b" };
  const run = (extra: Record<string, unknown>) => ({ schemaVersion: "agentops.event.v1", type: "command", command: "bun test", ...extra });
  const failed = run({ exitCode: 1, status: "failed" });
  const passed = run({ exitCode: 0, status: "completed" });

  test("six unanswered Claude edits stay in the file list but are not repeated edits", () => {
    const records: unknown[] = [init];
    for (let i = 0; i < 6; i++) records.push(use(`e${i}`, "Edit", editInput));
    const { flags, files } = ingest([...records, done]);
    expect(files).toBe(6);
    expect(flags).toEqual([]);
  });

  test("an unanswered Claude edit does not separate a retry", () => {
    const { flags } = ingest([init, use("b1", "Bash", { command: "bun test" }), result("b1", true), use("e1", "Edit", editInput), use("b2", "Bash", { command: "bun test" }), result("b2", false), done]);
    expect(flags).toEqual(["low:retry-without-change:Command re-run 1 time after failing, with no file change in between: bun test"]);
  });

  test("a skipped rerun, or one with no status and no exit code, is not a retry", () => {
    expect(generic([failed, run({ status: "skipped" })])).toEqual([]);
    expect(generic([failed, run({ status: "skipped", exitCode: 0 })])).toEqual([]);
    expect(generic([failed, run({})])).toEqual([]);
  });

  test("a denied run with exit code 1 is not a failure", () => {
    expect(generic([run({ status: "denied", exitCode: 1 }), passed])).toEqual([]);
    expect(generic([failed, run({ status: "declined", exitCode: 1 })])).toEqual([]);
  });

  test("a timeout followed by a successful rerun is a retry", () => {
    expect(generic([run({ status: "timed_out" }), passed])).toEqual(["low:retry-without-change:Command re-run 1 time after failing, with no file change in between: bun test"]);
  });

  test("here-doc bodies that differ by one space, or a nonbreaking space, are different commands", () => {
    const heredoc = (body: string) => run({ command: `cat <<'EOF' > a.txt\n${body}\nEOF`, exitCode: 1, status: "failed" });
    expect(generic([heredoc("a b"), heredoc("a  b")])).toEqual([]);
    expect(generic([run({ command: "bun test a.ts", exitCode: 1, status: "failed" }), run({ command: "bun test\u00a0a.ts", exitCode: 0, status: "completed" })])).toEqual([]);
  });
});
