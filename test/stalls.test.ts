import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig, validateConfigFile } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
import { parseJsonlTranscript } from "../src/parser";
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

  test("one retry is low severity; whitespace differences are the same command", () => {
    const flags = detectStalls([cmd(1, 1, "bun  test", 1), cmd(2, 2, "bun test", 0)], [], opts);
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

  test("whitespace inside quotes is part of the argument", () => {
    expect(normalizeCommand(`bun   test  "test/a  b.test.ts"`)).toBe(`bun test "test/a  b.test.ts"`);
    expect(normalizeCommand(`bun test 'x  y'   z`)).toBe(`bun test 'x  y' z`);
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
