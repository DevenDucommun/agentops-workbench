import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
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
      const testClaim = ledger.claims.find((c) => c.id === "test");
      expect(testClaim?.verdict).toBe(verdict as "supported");
      expect(testClaim?.cited?.outcome ?? null).toBe(outcome as "passed" | "failed" | null);
    });
  }

  test("a supported claim cites the passing run by eventId, after the failed one", () => {
    const { store, sessionId } = ingest("fixtures/ledger/fail-then-pass-then-claim.jsonl");
    const ledger = getClaimsLedger(store, sessionId);
    store.db.close();
    const claim = ledger.claims.find((c) => c.id === "test") as (typeof ledger.claims)[number];
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
    const claim = getClaimsLedger(store, sessionId).claims.find((c) => c.id === "test") as ReturnType<typeof getClaimsLedger>["claims"][number];
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

describe("buildClaimsLedger", () => {
  const run = (id: number, eventId: number | null, command: string, status: string | null, exitCode: number | null) => ({ id, eventId, command, status, exitCode, output: null });
  const final = (rowId: number, text: string) => ({ rowId, eventId: null, text });

  test("runs after the final response, and runs that never executed, are ignored", () => {
    const ledger = buildClaimsLedger({
      sessionId: "s",
      finalEvent: final(5, "Tests pass."),
      runs: [run(1, 2, "bun test", "failed", 1), run(2, 3, "bun test", "denied", null), run(3, 6, "bun test", "completed", 0)],
      eventIds: new Map()
    });
    expect(ledger.claims.map((c) => [c.verdict, c.evidence.length])).toEqual([["contradicted", 1]]);
  });

  test("several claims in one response get separate verdicts", () => {
    const ledger = buildClaimsLedger({
      sessionId: "s",
      finalEvent: final(9, "Tests pass, lint is clean and the build succeeded."),
      runs: [run(1, 2, "bun test", "completed", 0), run(2, 3, "bun run lint", "completed", 2)],
      eventIds: new Map([[2, "evt-a"]])
    });
    expect(ledger.claims.map((c) => [c.id, c.verdict, c.cited?.eventId ?? null])).toEqual([
      ["test", "supported", "evt-a"],
      ["lint", "contradicted", null],
      ["build", "unsupported", null]
    ]);
  });

  test("no final response means no claims", () => {
    expect(buildClaimsLedger({ sessionId: "s", finalEvent: null, runs: [run(1, 1, "bun test", "completed", 0)], eventIds: new Map() }).claims).toEqual([]);
  });

  test("outcome: non-zero exit or failed status fails; unknown exit with no failure status passes", () => {
    expect(commandOutcome({ status: "completed", exitCode: 1 })).toBe("failed");
    expect(commandOutcome({ status: "failed", exitCode: null })).toBe("failed");
    expect(commandOutcome({ status: "completed", exitCode: null })).toBe("passed");
    expect(commandOutcome({ status: null, exitCode: 0 })).toBe("passed");
  });
});

describe("T2.2: claim categories", () => {
  const cases: Array<[string, string, string]> = [
    ["callers-searched", "callers", "supported"],
    ["callers-unsearched", "callers", "unsupported"],
    ["device-checked", "device", "supported"],
    ["device-unchecked", "device", "unsupported"],
    ["browser-checked", "browser", "supported"],
    ["browser-unchecked", "browser", "unsupported"],
    ["fix-verified", "fix", "supported"],
    ["fix-unverified", "fix", "unsupported"]
  ];
  for (const [name, id, verdict] of cases) {
    test(`${name}: the ${id} claim is ${verdict}`, () => {
      const { store, sessionId } = ingest(`fixtures/ledger/${name}.jsonl`);
      const ledger = getClaimsLedger(store, sessionId);
      const flags = getRiskFlags(store, sessionId).map((f) => f.category);
      store.db.close();
      expect(ledger.claims.map((c) => `${c.id}:${c.verdict}`)).toEqual([`${id}:${verdict}`]);
      if (verdict === "unsupported") expect(flags).toContain(`missing-${id}-evidence`);
      else expect(flags.filter((c) => c.startsWith("missing-") || c.endsWith("-claim"))).toEqual([]);
    });
  }

  test("unsupported messages name what was missing", () => {
    const { store, sessionId } = ingest("fixtures/ledger/fix-unverified.jsonl");
    const flags = getRiskFlags(store, sessionId);
    store.db.close();
    expect(flags.map((f) => f.message)).toContain("Final response claims a fix, but no verification command ran after the last edit.");
  });

  const run = (eventRowId: number, text: string, exitCode: number | null, source: "command" | "tool" = "command", status: string | null = "completed") => ({ source, eventRowId, text, status, exitCode });
  const final = (rowId: number, text: string) => ({ rowId, eventId: null, text });
  const verdicts = (text: string, runs: ReturnType<typeof run>[], lastEditRowId: number | null = null) =>
    buildClaimsLedger({ sessionId: "s", finalEvent: final(99, text), runs, eventIds: new Map(), lastEditRowId }).claims.map((c) => `${c.id}:${c.verdict}`);

  test("a search with no matches (exit 1) backs a no-callers claim; a search error does not", () => {
    expect(verdicts("No other usages remain.", [run(1, "grep -rn oldName src", 1, "command", "failed")])).toEqual(["callers:supported"]);
    expect(verdicts("No other usages remain.", [run(1, "rg oldName missing-dir", 2, "command", "failed")])).toEqual(["callers:contradicted"]);
    expect(verdicts("It is not referenced anywhere.", [run(1, "Grep", null, "tool")])).toEqual(["callers:supported"]);
  });

  test("device and browser claims accept MCP tool calls", () => {
    expect(verdicts("Tested on the device and it works.", [run(1, "mcp__router__router_exec", null, "tool")])).toEqual(["device:supported"]);
    expect(verdicts("Verified in Chrome.", [run(1, "mcp__playwright__browser_snapshot", null, "tool", "failed")])).toEqual(["browser:contradicted"]);
    expect(verdicts("Verified in the browser.", [run(1, "Grep", null, "tool")])).toEqual(["browser:unsupported"]);
  });

  test("a fix claim needs a verification run after the last edit, or any run when nothing was edited", () => {
    expect(verdicts("Fixed.", [run(1, "bun test", 0)], 5)).toEqual(["fix:unsupported"]);
    expect(verdicts("Fixed.", [run(1, "bun test", 0), run(6, "bun run lint", 1)], 5)).toEqual(["fix:contradicted"]);
    expect(verdicts("Resolved; it now works.", [run(1, "bun test", 0)], null)).toEqual(["fix:supported"]);
    expect(verdicts("Fixed.", [run(6, "ls -la", 0)], 5)).toEqual(["fix:unsupported"]);
  });

  test("prose without a claim gets no verdict", () => {
    expect(verdicts("I renamed the helper and updated the docs.", [])).toEqual([]);
  });
});
