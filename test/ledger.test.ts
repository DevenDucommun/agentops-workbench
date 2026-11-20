import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
import { parseClaudeCodeStreamJsonl } from "../src/claudeStream";
import { parseCodexExecJsonl } from "../src/codexExec";
import { buildClaimsLedger, commandOutcome, eventRef, getClaimsLedger } from "../src/ledger";
import { parseJsonlTranscript } from "../src/parser";
import { getRiskFlags, ingestTranscript, openStore } from "../src/store";

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

describe("claims are detected per sentence and clause", () => {
  const run = (id: number, command: string, exitCode: number) => ({ id, eventId: id, command, status: exitCode === 0 ? "completed" : "failed", exitCode, output: null });
  const claimsFor = (text: string) =>
    buildClaimsLedger({ sessionId: "s", finalEvent: { rowId: 9, eventId: null, text }, commands: [run(1, "bun test", 1), run(2, "bun run lint", 0)], eventIds: new Map() }).claims.map(
      (c) => [c.id, c.verdict]
    );

  test("a test failure and a lint success in separate sentences raise only the lint claim", () => {
    expect(claimsFor("The tests failed. Lint passed.")).toEqual([["lint", "supported"]]);
    expect(claimsFor("tests failed\nlint passed")).toEqual([["lint", "supported"]]);
  });

  test("a contrastive clause does not lend its success word to the previous clause", () => {
    expect(claimsFor("The tests failed, but lint passed.")).toEqual([["lint", "supported"]]);
    expect(claimsFor("Two tests still fail; lint is clean.")).toEqual([["lint", "supported"]]);
  });

  test("a claim inside one sentence is still found", () => {
    expect(claimsFor("Tests pass and lint is clean.")).toEqual([
      ["test", "contradicted"],
      ["lint", "supported"]
    ]);
  });

  test("the accurate mixed report passes the gate end to end", () => {
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
    expect(categories).not.toContain("contradicted-claim");
    expect(gate.checks.find((c) => c.id === "unsupported-final-claims")?.status).toBe("passed");
  });
});

describe("only executed verification commands are evidence", () => {
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

  test("a text search that mentions a test command does not override the passing test run", () => {
    expect(cite("All tests pass.", ["bun test", 0], ["rg 'bun test' README.md", 1])).toEqual(["supported", "bun test"]);
    expect(cite("All tests pass.", ["bun test", 0], ["rg 'test instructions' README.md", 1])).toEqual(["supported", "bun test"]);
  });

  test("commands that only mention a verification command are not evidence", () => {
    for (const command of ["rg 'bun test' README.md", 'grep -rn "npm test" docs', "echo bun test", "git commit -m 'make test pass'"]) {
      expect(cite("All tests pass.", [command, 0])).toEqual(["unsupported", null]);
    }
  });

  test("wrapped, chained and prefixed invocations still count", () => {
    for (const command of [
      "/bin/zsh -lc 'bun test'",
      'bash -c "cd app && bun test"',
      "cd app && bun test --coverage",
      "CI=1 bun test",
      "bun install && bun run test",
      "timeout 120 cargo test",
      "env NODE_ENV=test npm test",
      "/usr/local/bin/pytest -q"
    ]) {
      expect(cite("All tests pass.", [command, 0])).toEqual(["supported", command]);
    }
    expect(cite("Typecheck passed.", ["npx tsc --noEmit", 0])).toEqual(["supported", "npx tsc --noEmit"]);
  });

  test("a compound command's exit code is only attributed to a test when it is the test's own", () => {
    // The shell's single exit code belongs to the test: a lone test, a test after `;`,
    // a test after setup-only steps, or an all-`&&` chain that exited 0.
    expect(cite("All tests pass.", ["bun test 2>&1", 1])).toEqual(["contradicted", "bun test 2>&1"]);
    expect(cite("All tests pass.", ["false; bun test", 0])).toEqual(["supported", "false; bun test"]);
    expect(cite("All tests pass.", ["cd app && bun test", 1])).toEqual(["contradicted", "cd app && bun test"]);
    expect(cite("All tests pass.", ["bun install && bun test", 0])).toEqual(["supported", "bun install && bun test"]);
    expect(cite("All tests pass.", ["bun test && bun run lint", 0])).toEqual(["supported", "bun test && bun run lint"]);
    // Otherwise the test's own outcome is unknown, so the run is not evidence either way.
    for (const [command, exitCode] of [
      ["bun test && false", 1],
      ["bun test ; true", 0],
      ["true || bun test", 0],
      ["bun test || true", 0],
      ["bun test | tail -5", 0],
      ["bun install && bun test", 1],
      ["bun test &", 0]
    ] as Array<[string, number]>) {
      expect(cite("All tests pass.", [command, exitCode])).toEqual(["unsupported", null]);
    }
  });

  test("a compound command with an unknown test outcome leaves an earlier completed failure cited", () => {
    expect(cite("All tests pass.", ["bun test", 1], ["bun test ; true", 0])).toEqual(["contradicted", "bun test"]);
  });

  test("a Claude-style failed status without an exit code follows the same attribution", () => {
    const [claim] = buildClaimsLedger({
      sessionId: "s",
      finalEvent: { rowId: 99, eventId: null, text: "All tests pass." },
      commands: [{ id: 1, eventId: 1, command: "bun test && false", status: "failed", exitCode: null, output: null }],
      eventIds: new Map()
    }).claims;
    expect(claim.verdict).toBe("unsupported");
  });

  test("wrapper options are consumed with their operands, and lookups are not runs", () => {
    for (const command of [
      "env -u CI bun test",
      "env --unset=CI bun test",
      "env -C app bun test",
      "timeout -s KILL 20 bun test",
      "timeout --signal=KILL -k 5 20 bun test",
      "nice -n 5 bun test",
      "sudo -u ci bun test",
      "command bun test"
    ]) {
      expect(cite("All tests pass.", [command, 0])).toEqual(["supported", command]);
    }
    expect(cite("Typecheck passed.", ["npx -p typescript tsc --noEmit", 0])).toEqual(["supported", "npx -p typescript tsc --noEmit"]);
    for (const command of ["command -v bun test", "command -V bun test", "env -u bun test"]) {
      expect(cite("All tests pass.", [command, 0])).toEqual(["unsupported", null]);
    }
  });
});

describe("claims: coordination, negation and labels", () => {
  const run = (id: number, command: string, exitCode: number) => ({ id, eventId: id, command, status: exitCode === 0 ? "completed" : "failed", exitCode, output: null });
  const claimsFor = (text: string) =>
    buildClaimsLedger({ sessionId: "s", finalEvent: { rowId: 9, eventId: null, text }, commands: [run(1, "bun test", 1), run(2, "bun run lint", 0)], eventIds: new Map() }).claims.map(
      (c) => [c.id, c.verdict]
    );

  test("independent clauses joined by 'and' keep their own verdict words", () => {
    expect(claimsFor("Tests failed and lint passed.")).toEqual([["lint", "supported"]]);
    expect(claimsFor("Tests failed, lint passed.")).toEqual([["lint", "supported"]]);
  });

  test("a shared verdict across 'and' still claims both", () => {
    expect(claimsFor("Tests and lint passed.")).toEqual([
      ["test", "contradicted"],
      ["lint", "supported"]
    ]);
  });

  test("a negated success word is not a claim", () => {
    for (const text of ["Tests did not pass.", "Tests didn't pass.", "The tests are not passing.", "Tests never passed.", "Tests still don’t pass."]) {
      expect(claimsFor(text)).toEqual([]);
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

  test("the store has a nullable events.text column", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-")), "agentops.db"));
    const columns = (store.db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
    store.db.close();
    expect(columns).toContain("text");
  });

  test("a claim beyond the 120-character summary is found in the full text", () => {
    expect(audit(`${prose} All tests pass.`, (full) => full)).toEqual([["test", "contradicted"]]);
  });

  test("legacy rows without full text fall back to the summary", () => {
    expect(audit("All tests pass.", () => null)).toEqual([["test", "contradicted"]]);
  });
});
