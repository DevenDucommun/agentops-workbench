import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession, evaluateEvidenceClaims } from "../src/analyzer";
import { defaultConfig, validateConfigFile } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
import { parseClaudeCodeStreamJsonl } from "../src/claudeStream";
import { parseClaudeHooksJsonl } from "../src/claudeHooks";
import { parseCodexExecJsonl } from "../src/codexExec";
import { buildClaimsLedger, commandOutcome, eventRef, getClaimsLedger, hasRecordedOutcome, isSafeSupportCommand } from "../src/ledger";
import { parseJsonlTranscript } from "../src/parser";
import { getCommands, getRiskFlags, ingestTranscript, openStore } from "../src/store";

const ROOT = join(import.meta.dir, "..");

function ingest(fixture: string) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
  const path = join(ROOT, fixture);
  const { sessionId } = ingestTranscript(store, parseJsonlTranscript(path, readFileSync(path, "utf8")), defaultConfig);
  analyzeSession(store, sessionId, defaultConfig);
  return { store, sessionId };
}

describe("AC7: claim verdicts", () => {
  const cases: Array<[string, string, string | null]> = [
    ["pass-then-claim", "supported", "passed"],
    ["fail-then-claim", "contradicted", "failed"],
    ["no-run-then-claim", "unsupported", null],
    ["fail-then-pass-then-claim", "supported", "passed"]
  ];
  for (const [name, verdict, outcome] of cases) {
    test(`${name}: the test claim is ${verdict}`, () => {
      const { store, sessionId } = ingest(`fixtures/ledger/${name}.jsonl`);
      const ledger = getClaimsLedger(store, sessionId);
      store.db.close();
      expect(ledger.claims.map((c) => `${c.id}:${c.verdict}`)).toEqual([`test:${verdict}`]);
      expect(ledger.claims[0].cited?.outcome ?? null).toBe(outcome as "passed" | "failed" | null);
    });
  }

  test("a supported claim cites the passing run by eventId, after the failed one", () => {
    const { store, sessionId } = ingest("fixtures/ledger/fail-then-pass-then-claim.jsonl");
    const ledger = getClaimsLedger(store, sessionId);
    store.db.close();
    const [claim] = ledger.claims;
    expect(ledger.finalEventId).toBe("evt-0003-final");
    expect(claim.evidence.map((e) => [e.eventId, e.outcome])).toEqual([
      ["evt-0001-test-fail", "failed"],
      ["evt-0002-test-pass", "passed"]
    ]);
    expect(claim.cited?.eventId).toBe("evt-0002-test-pass");
    expect(claim.reason).toBe("Latest test run passed: bun test (exit 0), after 1 earlier run.");
  });

  test("legacy sessions without eventIds cite stored row IDs", () => {
    const { store, sessionId } = ingest("fixtures/ledger/fail-then-claim.jsonl");
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.cited?.eventId).toBeNull();
    expect(claim.cited?.eventRowId).toEqual(expect.any(Number));
    expect(eventRef(claim.cited ?? { eventId: null, eventRowId: null })).toMatch(/^#\d+$/);
  });
});

describe("analyzer and gate", () => {
  test("a contradicted claim raises contradicted-claim and fails the gate", () => {
    const { store, sessionId } = ingest("fixtures/ledger/fail-then-claim.jsonl");
    const flags = getRiskFlags(store, sessionId);
    const gate = evaluateQualityGate(store, sessionId, defaultConfig, { gitChanges: [] });
    store.db.close();
    expect(flags.map((f) => [f.category, f.message])).toContainEqual([
      "contradicted-claim",
      "Final response claims test success, but the latest test run failed: bun test (exit 1)."
    ]);
    expect(flags.map((f) => f.category)).not.toContain("missing-test-evidence");
    expect(flags.map((f) => f.category)).not.toContain("unsupported-success-claim");
    expect(gate.checks.find((c) => c.id === "unsupported-final-claims")?.status).toBe("failed");
  });

  test("unsupported claims keep their v3.2 flag; supported claims raise none", () => {
    const none = ingest("fixtures/ledger/no-run-then-claim.jsonl");
    expect(getRiskFlags(none.store, none.sessionId).map((f) => f.category)).toContain("missing-test-evidence");
    none.store.db.close();
    for (const name of ["pass-then-claim", "fail-then-pass-then-claim"]) {
      const { store, sessionId } = ingest(`fixtures/ledger/${name}.jsonl`);
      const categories = getRiskFlags(store, sessionId).map((f) => f.category);
      const gate = evaluateQualityGate(store, sessionId, defaultConfig, { gitChanges: [] });
      store.db.close();
      expect(categories.filter((c) => c.endsWith("-evidence") || c.endsWith("-claim"))).toEqual([]);
      expect(gate.checks.find((c) => c.id === "unsupported-final-claims")?.status).toBe("passed");
    }
  });
});

describe("Codex: an unfinished retry", () => {
  const stream = (retry: string) =>
    [
      `{"type":"thread.started","thread_id":"codex-ledger-retry"}`,
      `{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"bun test","status":"failed","exit_code":1,"output":"1 fail"}}`,
      retry,
      `{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"All tests pass."}}`
    ].join("\n");
  const verdict = (retry: string) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const { sessionId } = ingestTranscript(store, parseCodexExecJsonl("codex.jsonl", stream(retry)), defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    return claim?.verdict;
  };

  test("item.started without a result leaves the failed run as the verdict", () => {
    expect(verdict(`{"type":"item.started","item":{"id":"c2","type":"command_execution","command":"bun test"}}`)).toBe("contradicted");
  });

  test("a completed passing retry supports the claim", () => {
    expect(verdict(`{"type":"item.completed","item":{"id":"c2","type":"command_execution","command":"bun test","status":"completed","exit_code":0,"output":"ok"}}`)).toBe("supported");
  });
});

describe("buildClaimsLedger", () => {
  const run = (id: number, eventId: number | null, command: string, status: string | null, exitCode: number | null) => ({ id, eventId, command, status, exitCode, output: null });
  const final = (rowId: number, text: string) => ({ rowId, eventId: null, text });

  test("runs after the final response, and runs that never executed, are ignored", () => {
    const ledger = buildClaimsLedger({
      sessionId: "s",
      finalEvent: final(5, "Tests pass."),
      commands: [run(1, 2, "bun test", "failed", 1), run(2, 3, "bun test", "denied", null), run(3, 6, "bun test", "completed", 0)],
      eventIds: new Map()
    });
    expect(ledger.claims.map((c) => [c.verdict, c.evidence.length])).toEqual([["contradicted", 1]]);
  });

  test("a started run with no result is not evidence; the last completed run decides", () => {
    const ledger = buildClaimsLedger({
      sessionId: "s",
      finalEvent: final(9, "All tests pass."),
      commands: [run(1, 2, "bun test", "failed", 1), run(2, 3, "bun test", "in_progress", null)],
      eventIds: new Map()
    });
    expect(ledger.claims.map((c) => [c.verdict, c.evidence.length, c.cited?.status])).toEqual([["contradicted", 1, "failed"]]);
    const none = buildClaimsLedger({ sessionId: "s", finalEvent: final(9, "All tests pass."), commands: [run(1, 2, "bun test", "running", null)], eventIds: new Map() });
    expect(none.claims.map((c) => c.verdict)).toEqual(["unsupported"]);
  });

  test("several claims in one response get separate verdicts", () => {
    const ledger = buildClaimsLedger({
      sessionId: "s",
      finalEvent: final(9, "Tests pass, lint is clean and the build succeeded."),
      commands: [run(1, 2, "bun test", "completed", 0), run(2, 3, "bun run lint", "completed", 2)],
      eventIds: new Map([[2, "evt-a"]])
    });
    expect(ledger.claims.map((c) => [c.id, c.verdict, c.cited?.eventId ?? null])).toEqual([
      ["test", "supported", "evt-a"],
      ["lint", "contradicted", null],
      ["build", "unsupported", null]
    ]);
  });

  test("no final response means no claims", () => {
    expect(buildClaimsLedger({ sessionId: "s", finalEvent: null, commands: [run(1, 1, "bun test", "completed", 0)], eventIds: new Map() }).claims).toEqual([]);
  });

  test("outcome: non-zero exit or failed status fails; unknown exit with no failure status passes", () => {
    expect(commandOutcome({ status: "completed", exitCode: 1 })).toBe("failed");
    expect(commandOutcome({ status: "failed", exitCode: null })).toBe("failed");
    expect(commandOutcome({ status: "completed", exitCode: null })).toBe("passed");
    expect(commandOutcome({ status: null, exitCode: 0 })).toBe("passed");
  });
});

describe("Claude Code: a Bash result decides the run's outcome", () => {
  const stream = (result: Record<string, unknown> | null) =>
    [
      { type: "system", subtype: "init", session_id: "claude-ledger-result" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_t1", name: "Bash", input: { command: "bun test" } }] } },
      ...(result ? [{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", ...result }] } }] : []),
      { type: "result", subtype: "success", session_id: "claude-ledger-result", result: "Updated the parser. All tests pass." }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
  const audit = (result: Record<string, unknown> | null) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream(result)), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const claims = getClaimsLedger(store, sessionId).claims.map((c) => [c.id, c.verdict, c.cited?.outcome ?? null]);
    const gate = evaluateQualityGate(store, sessionId, defaultConfig, { gitChanges: [] }).checks.find((c) => c.id === "unsupported-final-claims")?.status;
    store.db.close();
    return { claims, gate };
  };

  test("a failed tool_result contradicts the test claim", () => {
    expect(audit({ is_error: true, content: "1 fail" })).toEqual({ claims: [["test", "contradicted", "failed"]], gate: "failed" });
  });

  test("a tool_use with no tool_result is not evidence", () => {
    expect(audit(null)).toEqual({ claims: [["test", "unsupported", null]], gate: "failed" });
  });

  test("a successful tool_result supports the test claim", () => {
    expect(audit({ is_error: false, content: "3 pass" })).toEqual({ claims: [["test", "supported", "passed"]], gate: "passed" });
  });
});

describe("D: claims are detected at response level", () => {
  const run = (id: number, command: string, exitCode: number) => ({ id, eventId: id, command, status: exitCode === 0 ? "completed" : "failed", exitCode, output: null });
  const claimsFor = (text: string, commands = [run(1, "bun test", 1), run(2, "bun run lint", 0)]) =>
    buildClaimsLedger({ sessionId: "s", finalEvent: { rowId: 9, eventId: null, text }, commands, eventIds: new Map() }).claims.map((c) => [c.id, c.verdict]);

  test("a subject and a success word anywhere in the response make a claim", () => {
    const lintOnly = [run(2, "bun run lint", 0)];
    for (const text of ["Tests failed initially; passed on retry.", "Tests failed initially, but passed on retry.", "Tests\n\npassed.", "Tests ran. Everything passed."]) {
      expect(claimsFor(text, lintOnly)).toEqual([["test", "unsupported"]]);
    }
  });

  test("mixed reports claim every kind they mention with success vocabulary (stricter, never a missed claim)", () => {
    for (const text of ["The tests failed. Lint passed.", "Tests failed and lint passed.", "The tests failed, but lint passed.", "tests failed\nlint passed"]) {
      expect(claimsFor(text)).toEqual([
        ["test", "contradicted"],
        ["lint", "supported"]
      ]);
    }
  });

  test("a response without success vocabulary for a kind makes no claim for it", () => {
    expect(claimsFor("Two tests still fail.")).toEqual([]);
    expect(claimsFor("Updated the parser.")).toEqual([]);
  });

  test("the mixed report fails the gate end to end because tests are claimed", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript(
      "mixed.jsonl",
      [
        { schemaVersion: "agentops.event.v1", type: "session", id: "ledger-mixed" },
        { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Bash", input: { cmd: "bun test" }, status: "failed", exitCode: 1 },
        { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Bash", input: { cmd: "bun run lint" }, status: "completed", exitCode: 0 },
        { schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", content: "The tests failed. Lint passed." }
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
    );
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const categories = getRiskFlags(store, sessionId).map((f) => f.category);
    const gate = evaluateQualityGate(store, sessionId, defaultConfig, { gitChanges: [] });
    store.db.close();
    expect(categories).toContain("contradicted-claim");
    expect(gate.checks.find((c) => c.id === "unsupported-final-claims")?.status).toBe("failed");
  });
});

describe("A and B: asymmetric evidence", () => {
  const run = (id: number, command: string, exitCode: number) => ({ id, eventId: id, command, status: exitCode === 0 ? "completed" : "failed", exitCode, output: null });
  const cite = (text: string, ...commands: Array<[string, number]>) => {
    const [claim] = buildClaimsLedger({
      sessionId: "s",
      finalEvent: { rowId: 99, eventId: null, text },
      commands: commands.map(([command, exitCode], index) => run(index + 1, command, exitCode)),
      eventIds: new Map()
    }).claims;
    return [claim?.verdict, claim?.cited?.command ?? null];
  };

  test("B: only a configured command, word for word, supports (rule 3)", () => {
    for (const command of ["bun test", "bun run test", "npm test", "pytest", "make test", "  bun   test  "]) {
      expect(cite("Tests passed.", [command, 0])).toEqual(["supported", command]);
    }
    // Extra arguments, environment assignments, a different script or a dry run do not.
    for (const command of ["CI=1 bun test", "bun test a.test.ts", "bun test --coverage", "pytest -q", "make test --just-print", "MAKEFLAGS=n make test", "npm run TEST", "npm run test -- --watch=false"]) {
      expect(cite("Tests passed.", [command, 0])).toEqual(["unsupported", null]);
    }
  });

  test("B: evidence.supportCommands replaces a kind's built-in list", () => {
    const config = { ...defaultConfig, evidence: { ...defaultConfig.evidence, supportCommands: { test: ["bun run ci"] } } };
    const ledger = (command: string) =>
      buildClaimsLedger({ sessionId: "s", finalEvent: { rowId: 99, eventId: null, text: "Tests passed." }, commands: [run(1, command, 0)], eventIds: new Map(), config }).claims[0]
        ?.verdict;
    expect(ledger("bun run ci")).toBe("supported");
    expect(ledger("bun test")).toBe("unsupported");
  });

  test("B: passing runs that are not the strict shape never support", () => {
    for (const command of [
      "rg 'bun test' README.md",
      "echo bun test",
      "bun test && false",
      "bun test ; true",
      "true || bun test",
      "bun test | tail -5",
      "cd app && bun test",
      "bun test &",
      "echo $(bun test)",
      "echo `bun test`",
      "true # note; bun test",
      "bun test\nbun test",
      "/bin/zsh -lc 'bun test'",
      "env -u CI bun test",
      "timeout 20 bun test",
      "bun test --help",
      "bun test -h",
      "bun test -V",
      "bun test --version",
      "pytest --collect-only",
      "npm test --dry-run",
      "cargo test --list",
      'bun test "--help"',
      "bun test --he\\lp",
      "bun test --help>/dev/null",
      "make test -kh",
      "make test -kn",
      "make test -knj2",
      "go test -run TestRegression",
      "npm run test:label",
      "npm run test label",
      "bun test\tbad.test.ts",
      "make test-docs"
    ]) {
      expect(cite("Tests passed.", [command, 0])).toEqual(["unsupported", null]);
    }
    expect(cite("Typecheck passed.", ["npx tsc --noEmit", 0])).toEqual(["unsupported", null]);
  });

  test("A: a failed run that mentions the kind contradicts, whatever its shape", () => {
    for (const command of [
      "go test -run TestRegression",
      'bun test "bad.test.ts"',
      "bun test bad.test.ts > test.log",
      "cd missing && bun test",
      "bun test && false",
      "sh -c 'bun test'",
      "rg 'bun test' README.md"
    ]) {
      expect(cite("Tests passed.", ["bun test ok.test.ts", 0], [command, 1])).toEqual(["contradicted", command]);
    }
  });

  test("A: a later strict passing run supports again; a later non-strict pass does not", () => {
    expect(cite("Tests passed.", ["go test -run TestRegression", 1], ["bun test", 0])).toEqual(["supported", "bun test"]);
    expect(cite("Tests passed.", ["bun test", 1], ["bun test --help", 0])).toEqual(["contradicted", "bun test"]);
    expect(cite("Tests passed.", ["bun test", 1], ["bun test; true", 0])).toEqual(["contradicted", "bun test"]);
  });

  test("B: a non-shell tool's command never supports, in any adapter", () => {
    const ledger = buildClaimsLedger({
      sessionId: "s",
      finalEvent: { rowId: 99, eventId: null, text: "Tests passed." },
      commands: [run(1, "bun test", 0)],
      eventIds: new Map(),
      toolNames: new Map([[1, "mcp__demo__describe_command"]])
    });
    expect(ledger.claims.map((c) => c.verdict)).toEqual(["unsupported"]);
    for (const tool of ["Bash", "shell", "exec_command", "local_shell", "functions.exec_command"]) {
      const shell = buildClaimsLedger({ sessionId: "s", finalEvent: { rowId: 99, eventId: null, text: "Tests passed." }, commands: [run(1, "bun test", 0)], eventIds: new Map(), toolNames: new Map([[1, tool]]) });
      expect(shell.claims.map((c) => c.verdict)).toEqual(["supported"]);
    }
  });

  test("B: a generic JSONL non-shell tool call with input.command does not support", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript(
      "generic.jsonl",
      [
        { schemaVersion: "agentops.event.v1", type: "session", id: "ledger-generic-tool" },
        { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "mcp__demo__describe_command", input: { command: "bun test" }, status: "completed" },
        { schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", content: "Tests passed." }
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
    );
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const claims = getClaimsLedger(store, sessionId).claims.map((c) => c.verdict);
    store.db.close();
    expect(claims).toEqual(["unsupported"]);
  });
});

describe("claims: coordination, negation and labels", () => {
  const run = (id: number, command: string, exitCode: number) => ({ id, eventId: id, command, status: exitCode === 0 ? "completed" : "failed", exitCode, output: null });
  const claimsFor = (text: string) =>
    buildClaimsLedger({ sessionId: "s", finalEvent: { rowId: 9, eventId: null, text }, commands: [run(1, "bun test", 1), run(2, "bun run lint", 0)], eventIds: new Map() }).claims.map(
      (c) => [c.id, c.verdict]
    );

  test("clauses joined by 'and' in one sentence are checked together (stricter, never a missed claim)", () => {
    for (const text of ["Tests failed and lint passed.", "Tests failed, lint passed."]) {
      expect(claimsFor(text)).toEqual([
        ["test", "contradicted"],
        ["lint", "supported"]
      ]);
    }
  });

  test("an explicit summary's claims are checked alongside the full response", () => {
    const ledger = buildClaimsLedger({
      sessionId: "s",
      finalEvent: { rowId: 9, eventId: null, text: "Lint passed.", summary: "Tests passed." },
      commands: [run(2, "bun run lint", 0)],
      eventIds: new Map()
    });
    expect(ledger.claims.map((c) => [c.id, c.verdict])).toEqual([
      ["test", "unsupported"],
      ["lint", "supported"]
    ]);
  });

  test("a shared verdict across 'and' still claims both", () => {
    expect(claimsFor("Tests and lint passed.")).toEqual([
      ["test", "contradicted"],
      ["lint", "supported"]
    ]);
  });

  test("a negated or hedged success sentence is still a claim (over-detection)", () => {
    for (const text of ["Tests did not pass.", "No tests passed.", "Tests not only passed but finished early.", "Tests should pass now."]) {
      expect(claimsFor(text)).toEqual([["test", "contradicted"]]);
    }
  });

  test("a label with a colon is still a claim", () => {
    expect(claimsFor("Tests: passed.")).toEqual([["test", "contradicted"]]);
    expect(claimsFor("Verification: tests passed, lint clean.")).toEqual([
      ["test", "contradicted"],
      ["lint", "supported"]
    ]);
  });
});

describe("Claude Code: a result after the final response is not evidence", () => {
  const records = (...tail: unknown[]) =>
    [
      { type: "system", subtype: "init", session_id: "claude-late" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_t1", name: "Bash", input: { command: "bun test" } }] } },
      ...tail
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
  const ok = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", is_error: false, content: "1 pass" }] } };
  const final = (result: string) => ({ type: "result", subtype: "success", session_id: "claude-late", result });
  const verdict = (stream: string) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    const claims = getClaimsLedger(store, sessionId).claims.map((c) => c.verdict);
    const gate = evaluateQualityGate(store, sessionId, defaultConfig, { gitChanges: [] }).checks.find((c) => c.id === "unsupported-final-claims")?.status;
    store.db.close();
    return { claims, gate };
  };

  test("a successful result recorded after the final claim leaves the claim unsupported", () => {
    expect(verdict(records(final("All tests pass."), ok))).toEqual({ claims: ["unsupported"], gate: "failed" });
  });

  test("a result before the latest final response still counts", () => {
    expect(verdict(records(final("Working on it."), ok, final("All tests pass.")))).toEqual({ claims: ["supported"], gate: "passed" });
  });

  test("the first result after the call decides; a later duplicate cannot overturn it", () => {
    const failed = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", is_error: true, content: "1 fail" }] } };
    expect(verdict(records(failed, final("All tests pass."), ok))).toEqual({ claims: ["contradicted"], gate: "failed" });
  });

  test("a result recorded before its call is ignored", () => {
    const stream = [
      { type: "system", subtype: "init", session_id: "claude-early" },
      ok,
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_t1", name: "Bash", input: { command: "bun test" } }] } },
      final("All tests pass.")
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    expect(verdict(stream)).toEqual({ claims: ["unsupported"], gate: "failed" });
  });

  test("C: a reused tool_use id never shares an outcome between calls", () => {
    const call = (command: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_r", name: "Bash", input: { command } }] } });
    const res = (isError: boolean) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_r", is_error: isError, content: "out" }] } });
    const stream = (...rows: unknown[]) => [{ type: "system", subtype: "init", session_id: "claude-reuse" }, ...rows].map((record) => JSON.stringify(record)).join("\n");
    expect(verdict(stream(call("echo hello"), res(false), call("bun test"), res(true), final("All tests pass.")))).toEqual({ claims: ["contradicted"], gate: "failed" });
    expect(verdict(stream(call("echo hello"), res(false), call("bun test"), final("All tests pass.")))).toEqual({ claims: ["unsupported"], gate: "failed" });
    expect(verdict(stream(call("bun test"), res(true), call("bun test"), res(false), final("All tests pass.")))).toEqual({ claims: ["supported"], gate: "passed" });
  });

  test("a non-Bash tool whose input has a command field is not a shell command", () => {
    const stream = [
      { type: "system", subtype: "init", session_id: "claude-mcp" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_m1", name: "mcp__demo__describe_command", input: { command: "bun test" } }] } },
      final("All tests pass.")
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    const commands = getCommands(store, sessionId);
    const claims = getClaimsLedger(store, sessionId).claims.map((c) => c.verdict);
    store.db.close();
    expect(commands).toEqual([]);
    expect(claims).toEqual(["unsupported"]);
  });

  test("a later command keeps its recorded outcome in the session history", () => {
    const lintCall = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_l1", name: "Bash", input: { command: "bun run lint" } }] } };
    const lintError = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_l1", is_error: true, content: "1 error" }] } };
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", records(ok, final("All tests pass."), lintCall, lintError)), defaultConfig);
    const statuses = getCommands(store, sessionId).map((c) => [c.command, c.status]);
    const claims = getClaimsLedger(store, sessionId).claims.map((c) => [c.id, c.verdict]);
    store.db.close();
    expect(statuses).toEqual([
      ["bun test", "completed"],
      ["bun run lint", "failed"]
    ]);
    expect(claims).toEqual([["test", "supported"]]);
  });
});

describe("the ledger reads the full final response when the store has it", () => {
  const prose = "This change reorganizes the parser module and documents the behaviour for future readers, with notes on edge cases, history and follow-up work.";
  const audit = (finalText: string, storedText: (full: string) => string | null) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript(
      "long.jsonl",
      [
        { schemaVersion: "agentops.event.v1", type: "session", id: "ledger-long" },
        { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Bash", input: { cmd: "bun test" }, status: "failed", exitCode: 1 },
        { schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", content: finalText }
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
    );
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    // Simulates a store whose ingest saved the full final response (events.text).
    store.db.query("UPDATE events SET text = $text WHERE session_id = $sid AND type = 'final_response'").run({ $text: storedText(finalText), $sid: sessionId });
    const claims = getClaimsLedger(store, sessionId).claims.map((c) => [c.id, c.verdict]);
    store.db.close();
    return claims;
  };

  test("the ledger reads a store without events.text, and the first write adds the column", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const columns = () => (store.db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns()).not.toContain("text");
    expect(getClaimsLedger(store, "missing").claims).toEqual([]);
    const transcript = parseJsonlTranscript("t.jsonl", JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "with-text" }));
    ingestTranscript(store, transcript, defaultConfig);
    expect(columns()).toContain("text");
    store.db.close();
  });

  test("a claim beyond the 120-character summary is found in the full text", () => {
    expect(audit(`${prose} All tests pass.`, (full) => full)).toEqual([["test", "contradicted"]]);
  });

  test("legacy rows without full text fall back to the summary", () => {
    expect(audit("All tests pass.", () => null)).toEqual([["test", "contradicted"]]);
  });

  test("full text with a line break inside a claim is still a claim", () => {
    expect(audit("All tests\npass.", (full) => full)).toEqual([["test", "contradicted"]]);
  });

  test("a distinct claim in the stored summary is checked as well as the full text", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript(
      "summary.jsonl",
      [
        { schemaVersion: "agentops.event.v1", type: "session", id: "ledger-summary" },
        { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Bash", input: { cmd: "bun run lint" }, status: "completed", exitCode: 0 },
        { schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", content: "Lint passed.", summary: "Tests passed." }
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
    );
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    store.db.query("UPDATE events SET text = 'Lint passed.' WHERE session_id = $sid AND type = 'final_response'").run({ $sid: sessionId });
    const claims = getClaimsLedger(store, sessionId).claims.map((c) => [c.id, c.verdict]);
    store.db.close();
    expect(claims).toEqual([
      ["test", "unsupported"],
      ["lint", "supported"]
    ]);
  });
});

describe("regressions against the base: outcome order, terminal statuses, edit paths", () => {
  const ingestStream = (records: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const stream = records.map((record) => JSON.stringify(record)).join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    analyzeSession(store, sessionId, defaultConfig);
    return { store, sessionId };
  };
  const call = (id: string, command: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const result = (id: string, isError: boolean) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "out" }] } });

  test("overlapping Claude runs: the run whose result arrived last is cited", () => {
    const { store, sessionId } = ingestStream([
      { type: "system", subtype: "init", session_id: "claude-overlap" },
      call("toolu_a", "bun test a.test.ts"),
      call("toolu_b", "bun test b.test.ts"),
      result("toolu_b", false),
      result("toolu_a", true),
      { type: "result", subtype: "success", session_id: "claude-overlap", result: "Tests passed." }
    ]);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.command).toBe("bun test a.test.ts");
    expect(claim.cited?.outcome).toBe("failed");
  });

  test("a timed-out or cancelled run is a failure, never cited as a pass", () => {
    for (const status of ["timed_out", "cancelled", "interrupted"]) expect(commandOutcome({ status, exitCode: null })).toBe("failed");
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript(
      "timeout.jsonl",
      [
        { schemaVersion: "agentops.event.v1", type: "session", id: "ledger-timeout" },
        { schemaVersion: "agentops.event.v1", type: "command", command: "bun test", exitCode: 1, status: "failed" },
        { schemaVersion: "agentops.event.v1", type: "command", command: "bun test", status: "timed_out", output: "Timed out" },
        { schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", content: "Tests passed." }
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
    );
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.outcome).toBe("failed");
  });

  test("a Claude edit that names its file through input.file still records the changed file", () => {
    const { store, sessionId } = ingestStream([
      { type: "system", subtype: "init", session_id: "claude-file" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_e", name: "Write", input: { file: "src/a.ts", content: "x" } }] } },
      { type: "result", subtype: "success", session_id: "claude-file", result: "Done." }
    ]);
    const paths = store.db.query("SELECT path FROM file_changes WHERE session_id = $sid").all({ $sid: sessionId }) as Array<{ path: string }>;
    store.db.close();
    expect(paths.map((row) => row.path)).toEqual(["src/a.ts"]);
  });
});

describe("regressions against the base: outcome-less retries and stores written by the base", () => {
  const generic = (events: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript("retry.jsonl", events.map((event) => JSON.stringify(event)).join("\n"));
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    return claim;
  };
  const header = { schemaVersion: "agentops.event.v1", type: "session", id: "ledger-retry" };
  const failed = { schemaVersion: "agentops.event.v1", type: "command", command: "bun test a.ts", exitCode: 1, status: "failed" };
  const final = { schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", content: "Tests passed." };

  test("a skipped retry, or one with no recorded outcome, never displaces a recorded failure", () => {
    for (const retry of [{ status: "skipped" }, {}]) {
      const claim = generic([header, failed, { schemaVersion: "agentops.event.v1", type: "command", command: "bun test b.ts", ...retry }, final]);
      expect(claim.verdict).toBe("contradicted");
      expect(claim.cited?.command).toBe("bun test a.ts");
    }
    expect(hasRecordedOutcome({ status: "skipped", exitCode: null })).toBe(false);
    expect(hasRecordedOutcome({ status: null, exitCode: null })).toBe(false);
    expect(hasRecordedOutcome({ status: "completed", exitCode: null })).toBe(true);
  });

  const claudeStore = (records: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const stream = records.map((record) => JSON.stringify(record)).join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    // Stores written by the base did not record tool_use_id on Claude events and
    // stored every Bash call as completed, whatever its result (see the probe in review).
    store.db.query("UPDATE events SET tool_use_id = NULL WHERE session_id = $sid").run({ $sid: sessionId });
    store.db.query("UPDATE commands SET status = 'completed', exit_code = NULL WHERE session_id = $sid").run({ $sid: sessionId });
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    return claim;
  };
  const call = (id: string, command: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const both = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "bun test a.ts" } }, { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "bun test b.ts" } }] } };
  const result = (id: string, isError: boolean) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "out" }] } });
  const done = { type: "result", subtype: "success", session_id: "claude-legacy", result: "Tests passed." };
  const init = { type: "system", subtype: "init", session_id: "claude-legacy" };

  test("a base-written store never cites a Claude Bash call: its outcome cannot be attributed", () => {
    for (const records of [
      [init, both, result("toolu_b", false), result("toolu_a", true), done],
      [init, call("toolu_a", "bun test"), result("toolu_a", true), call("toolu_b", "bun test"), result("toolu_b", false), done],
      [init, call("toolu_a", "bun test"), result("toolu_a", true), call("toolu_b", "bun test"), done]
    ]) {
      const claim = claudeStore(records);
      expect(claim.verdict).toBe("unsupported");
      expect(claim.cited).toBeNull();
    }
  });

  test("an unrelated tool result never reorders generic command outcomes", () => {
    const claim = generic([
      header,
      { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "shell", command: "bun test", exitCode: 0, status: "completed" },
      { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Read", input: { path: "a.ts" }, status: "completed" },
      failed,
      { schemaVersion: "agentops.event.v1", type: "tool_result", status: "completed", output: "contents" },
      final
    ]);
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.command).toBe("bun test a.ts");
  });

  test("an explicit failed status survives an unrelated tool result, with or without an exit code", () => {
    const claim = generic([
      header,
      { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "shell", command: "bun test", exitCode: 0, status: "completed" },
      { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Read", input: { path: "a.ts" }, status: "completed" },
      { schemaVersion: "agentops.event.v1", type: "tool_result", status: "completed", output: "contents" },
      { schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Bash", command: "bun test a.ts", status: "failed" },
      final
    ]);
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.command).toBe("bun test a.ts");
  });

  test("a malformed is_error on a Claude result is a failure, never a pass", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const stream = [init, call("toolu_a", "bun test"), result("toolu_a", true), call("toolu_b", "bun test"), { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_b", is_error: "true", content: "out" }] } }, done]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
  });
});

describe("trust model rules 1 and 3 on generic imports", () => {
  const ledgerFor = (events: unknown[]) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript("rules.jsonl", events.map((event) => JSON.stringify(event)).join("\n"));
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    return claim;
  };
  const v1 = (event: Record<string, unknown>) => ({ schemaVersion: "agentops.event.v1", ...event });
  const header = v1({ type: "session", id: "ledger-rules" });
  const failedTest = v1({ type: "tool_call", toolName: "Bash", command: "bun test", exitCode: 1, status: "failed" });
  const final = v1({ type: "final_response", role: "assistant", content: "Tests passed." });
  const read = [v1({ type: "tool_call", toolName: "Read", input: { path: "a.ts" }, status: "completed" }), v1({ type: "tool_result", status: "completed", output: "contents" })];

  test("an unrelated tool result never discards a passing retry with its own exit code", () => {
    const claim = ledgerFor([header, failedTest, ...read, v1({ type: "tool_call", toolName: "Bash", command: "bun test", exitCode: 0, status: "completed" }), final]);
    expect(claim.verdict).toBe("supported");
  });

  test("a retry whose linked result failed is never cited as a pass", () => {
    const claim = ledgerFor([
      header,
      failedTest,
      v1({ type: "tool_call", toolName: "Bash", toolUseId: "t2", command: "bun test", status: "completed" }),
      v1({ type: "tool_result", toolUseId: "t2", status: "failed", output: "1 fail" }),
      final
    ]);
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.exitCode).toBe(1);
  });

  test("an MCP call, a file write or a dry run after a failed test never supports", () => {
    for (const retry of [
      v1({ type: "tool_call", toolName: "mcp__docs__reference.shell", input: { command: "bun test" }, status: "completed" }),
      v1({ type: "file_write", path: "notes.md", command: "bun test", status: "completed" }),
      v1({ type: "tool_call", toolName: "Bash", command: "make test --just-print", exitCode: 0, status: "completed" })
    ]) {
      const claim = ledgerFor([header, failedTest, retry, final]);
      expect(claim.verdict).toBe("contradicted");
      expect(claim.cited?.command).toBe("bun test");
    }
  });
});

describe("review 6001092236: configured failures, recorded outcomes, shell identity, safe commands", () => {
  const v1 = (event: Record<string, unknown>) => ({ schemaVersion: "agentops.event.v1", ...event });
  const ledgerFor = (events: unknown[], config = defaultConfig) => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const transcript = parseJsonlTranscript("r.jsonl", events.map((event) => JSON.stringify(event)).join("\n"));
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId, config).claims;
    store.db.close();
    return claim;
  };
  const header = v1({ type: "session", id: "ledger-r7" });
  const final = v1({ type: "final_response", role: "assistant", content: "Tests passed." });
  const ciConfig = { ...defaultConfig, evidence: { ...defaultConfig.evidence, supportCommands: { test: ["bun run ci"] } } };

  test("a configured command that passes and then fails contradicts the claim", () => {
    const claim = ledgerFor(
      [header, v1({ type: "command", command: "bun run ci", exitCode: 0 }), v1({ type: "command", command: "bun run ci", exitCode: 1 }), final],
      ciConfig
    );
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.exitCode).toBe(1);
  });

  test("a later separate result never hides a failure whose exit code was already recorded", () => {
    const claim = ledgerFor([
      header,
      v1({ type: "command", command: "bun test", exitCode: 0 }),
      v1({ type: "tool_call", toolName: "Bash", toolUseId: "t9", command: "bun test", exitCode: 1, status: "failed" }),
      final,
      v1({ type: "tool_result", toolUseId: "t9", status: "failed", output: "late" })
    ]);
    expect(claim.verdict).toBe("contradicted");
  });

  test("an MCP lookup or a file write carrying exit 0 never replaces a failed test", () => {
    for (const retry of [
      v1({ type: "tool_call", toolName: "docs.shell", command: "bun test", exitCode: 0, status: "completed" }),
      v1({ type: "tool_call", toolName: "mcp__docs__shell", command: "bun test", exitCode: 0, status: "completed" }),
      v1({ type: "file_write", path: "notes.md", command: "bun test", exitCode: 0, status: "completed" })
    ]) {
      const claim = ledgerFor([header, v1({ type: "command", command: "bun test", exitCode: 1 }), retry, final]);
      expect(claim.verdict).toBe("contradicted");
    }
  });

  test("configured short circuits, negation and rule 3's non-executing flags never support, and the config check reports them", () => {
    for (const unsafe of ["make test --dry-run", "bun test --help", "true || bun test", "bun test; true", "! bun test"]) {
      expect(isSafeSupportCommand(unsafe)).toBe(false);
      const config = { ...defaultConfig, evidence: { ...defaultConfig.evidence, supportCommands: { test: [unsafe] } } };
      expect(ledgerFor([header, v1({ type: "command", command: unsafe, exitCode: 0 }), final], config).verdict).toBe("unsupported");
    }
    const dir = mkdtempSync(join(tmpdir(), "agentops-cfg-"));
    writeFileSync(join(dir, "agentops.config.json"), JSON.stringify({ evidence: { supportCommands: { test: ["bun test --help"] } } }));
    expect(validateConfigFile(join(dir, "agentops.config.json")).errors.join(" ")).toContain("supportCommands.test");
  });

  test("a command with a non-breaking space never matches a configured command", () => {
    const nbsp = String.fromCharCode(0xa0);
    const claim = ledgerFor([header, v1({ type: "command", command: `bun test${nbsp}`, exitCode: 0 }), final]);
    expect(claim.verdict).toBe("unsupported");
  });
});

describe("review 6001207975: Claude outcomes at their result, precise non-executing checks", () => {
  test("a Claude failure whose result arrives after another call's pass is the cited run", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const both = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "bun test" } }, { type: "tool_use", id: "b", name: "Bash", input: { command: "bun test" } }] } };
    const result = (id: string, isError: boolean) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "out" }] } });
    const stream = [{ type: "system", subtype: "init", session_id: "r9" }, both, result("b", false), result("a", true), { type: "result", subtype: "success", session_id: "r9", result: "Tests passed." }]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.outcome).toBe("failed");
  });

  test("configured commands are trusted as written apart from rule 3's flags: owner forms such as make test -Cunit and go test -count=1 are valid", () => {
    for (const safe of ["go test -count=1 ./...", "make test -Cunit", "make -j4 test", "pytest -x", "CI=1 bun test"]) {
      expect(isSafeSupportCommand(safe)).toBe(true);
    }
    const dir = mkdtempSync(join(tmpdir(), "agentops-cfg-"));
    writeFileSync(join(dir, "agentops.config.json"), JSON.stringify({ evidence: { supportCommands: { test: ["go test -count=1 ./...", "make test -Cunit"] } } }));
    expect(validateConfigFile(join(dir, "agentops.config.json")).errors).toEqual([]);
  });
});

describe("review 6009611011: background runs and dashboard parity", () => {
  test("a Claude background run is still running: its launch acknowledgement never replaces a failure", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const call = (id: string, input: Record<string, unknown>) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input }] } });
    const result = (id: string, isError: boolean, content: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] } });
    const stream = [
      { type: "system", subtype: "init", session_id: "bg" },
      call("a", { command: "bun test" }),
      result("a", true, "1 fail"),
      call("b", { command: "bun test", run_in_background: true }),
      result("b", false, "Command running in background with ID: x"),
      { type: "result", subtype: "success", session_id: "bg", result: "Tests passed." }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.outcome).toBe("failed");
  });

  test("the dashboard counts a configured support command that passed as evidence", () => {
    const config = { ...defaultConfig, evidence: { ...defaultConfig.evidence, supportCommands: { test: ["bun run ci"] } } };
    expect(evaluateEvidenceClaims(["Tests passed."], ["bun run ci"], config).find((row) => row.id === "test")).toMatchObject({ claimed: true, supported: true, matchingCommand: "bun run ci" });
    expect(evaluateEvidenceClaims(["Tests passed."], ["bun run ci"]).find((row) => row.id === "test")?.supported).toBe(false);
  });
});

describe("review 6009703786: background acknowledgements are still running in both Claude adapters", () => {
  test("stream: a foreground test that timed out and moved to the background never replaces a failure", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const call = (id: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "bun test" } }] } });
    const stream = [
      { type: "system", subtype: "init", session_id: "bg2" },
      call("a"),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "1 fail" }] } },
      call("b"),
      {
        type: "user",
        tool_use_result: { backgroundTaskId: "task123", timedOutAfterMs: 1000 },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b", is_error: false, content: "Command running in background with ID: task123" }] }
      },
      { type: "result", subtype: "success", session_id: "bg2", result: "Tests passed." }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
    expect(claim.cited?.outcome).toBe("failed");
  });

  test("recorder: a background launch with a synthetic exit code 0 never replaces a failure", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const base = { session_id: "rec-bg", cwd: "/workspace" };
    const lines = [
      { ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "bun test" }, error: "exit 1" },
      { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "bun test", run_in_background: true }, tool_response: { stdout: "", backgroundTaskId: "task9" } },
      { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t3", tool_input: { command: "bun test" }, tool_response: { stdout: "", backgroundTaskId: "task10" } },
      { ...base, hook_event_name: "Stop", last_assistant_message: "Tests passed." }
    ];
    const transcript = parseClaudeHooksJsonl("rec.jsonl", lines.map((line) => JSON.stringify(line)).join("\n"), defaultConfig);
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
  });
});

describe("review on e289e55: failures stay failures; background detection uses Claude Code's metadata only", () => {
  test("recorder: a background run that reports failure (PostToolUseFailure) is a failure", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const base = { session_id: "rec-bgfail", cwd: "/workspace" };
    const lines = [
      { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "bun test" }, tool_response: { stdout: "1 pass" } },
      { ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "bun test", run_in_background: true }, error: "exit 1" },
      { ...base, hook_event_name: "Stop", last_assistant_message: "Tests passed." }
    ];
    const transcript = parseClaudeHooksJsonl("rec.jsonl", lines.map((line) => JSON.stringify(line)).join("\n"), defaultConfig);
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("contradicted");
  });

  test("stream: a foreground test that prints the background phrase is an ordinary completed run", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const stream = [
      { type: "system", subtype: "init", session_id: "phrase" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "make test" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: false, content: "Command running in background with ID: 7\nok" }] } },
      { type: "result", subtype: "success", session_id: "phrase", result: "Tests passed." }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const { sessionId } = ingestTranscript(store, parseClaudeCodeStreamJsonl("claude.jsonl", stream), defaultConfig);
    const [claim] = getClaimsLedger(store, sessionId).claims;
    store.db.close();
    expect(claim.verdict).toBe("supported");
  });
});

describe("review on 1ab87cb: interrupted background runs; unfinished configured commands", () => {
  test("recorder: a background run reported as interrupted keeps its interrupted status", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const base = { session_id: "rec-int", cwd: "/workspace" };
    const lines = [
      { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "bun test", run_in_background: true }, tool_response: { stdout: "", interrupted: true, backgroundTaskId: "x" } },
      { ...base, hook_event_name: "Stop", last_assistant_message: "Done." }
    ];
    const transcript = parseClaudeHooksJsonl("rec.jsonl", lines.map((line) => JSON.stringify(line)).join("\n"), defaultConfig);
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    const statuses = getCommands(store, sessionId).map((command) => command.status);
    store.db.close();
    expect(statuses).toEqual(["interrupted"]);
  });

  test("dashboard evidence: a configured command that did not pass is not evidence; loose matches stay as on main", () => {
    const config = { ...defaultConfig, evidence: { ...defaultConfig.evidence, supportCommands: { test: ["bun run ci"] } } };
    // Started, failed, or unanswered: not in the passing list, so not evidence.
    expect(evaluateEvidenceClaims(["Tests passed."], ["bun run ci"], config, []).find((row) => row.id === "test")?.supported).toBe(false);
    // A command that mentions the kind matches loosely, with or without config, as on main.
    for (const command of ["make test -Cunit", "go test -count=1 ./..."]) {
      expect(evaluateEvidenceClaims(["Tests passed."], [command]).find((row) => row.id === "test")?.supported).toBe(true);
    }
  });
});
