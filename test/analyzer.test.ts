import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession, claimsFinalSuccess, evaluateEvidenceClaims } from "../src/analyzer";
import { defaultConfig, type AgentOpsConfig } from "../src/config";
import { parseForensicTextTranscript } from "../src/forensicText";
import { parseJsonlTranscript } from "../src/parser";
import { getRiskFlags, ingestTranscript, openStore } from "../src/store";

test("flags risky commands, paths, churn, and missing verification", () => {
  const store = openFixture("fixtures/risky-session.jsonl");
  analyzeSession(store, "risky-session", defaultConfig);

  const categories = getRiskFlags(store, "risky-session").map((flag) => flag.category);
  expect(categories).toContain("destructive-command");
  expect(categories).toContain("sensitive-file");
  expect(categories).toContain("production-config");
  expect(categories).toContain("large-churn");
  expect(categories).toContain("unsupported-success-claim");

  store.db.close();
});

test("supports narrow config suppressions", () => {
  const store = openFixture("fixtures/risky-session.jsonl");
  const config: AgentOpsConfig = {
    ...defaultConfig,
    suppressions: [
      {
        category: "large-churn",
        path: "deploy/production.yaml",
        reason: "Synthetic test suppression."
      }
    ]
  };
  analyzeSession(store, "risky-session", config);

  const categories = getRiskFlags(store, "risky-session").map((flag) => flag.category);
  expect(categories).not.toContain("large-churn");
  expect(categories).toContain("production-config");

  store.db.close();
});

test("flags specific evidence claims without matching commands", () => {
  const store = openInlineFixture([
    { schemaVersion: "agentops.event.v1", type: "session", id: "evidence-claims" },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 },
    {
      schemaVersion: "agentops.event.v1",
      type: "final_response",
      content: "Tests passed. Lint is clean, typecheck passed, and the build completed successfully."
    }
  ]);
  analyzeSession(store, "evidence-claims", defaultConfig);

  const categories = getRiskFlags(store, "evidence-claims").map((flag) => flag.category);
  expect(categories).not.toContain("missing-test-evidence");
  expect(categories).toContain("missing-lint-evidence");
  expect(categories).toContain("missing-typecheck-evidence");
  expect(categories).toContain("missing-build-evidence");
  expect(categories).not.toContain("unsupported-success-claim");

  store.db.close();
});

test("accepts specific evidence claims with matching commands", () => {
  const store = openInlineFixture([
    { schemaVersion: "agentops.event.v1", type: "session", id: "supported-claims" },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun run lint" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun run typecheck" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun run build" }, status: "completed", exitCode: 0 },
    {
      schemaVersion: "agentops.event.v1",
      type: "final_response",
      content: "Tests passed. Lint is clean, typecheck passed, and the build completed successfully."
    }
  ]);
  analyzeSession(store, "supported-claims", defaultConfig);

  expect(getRiskFlags(store, "supported-claims")).toEqual([]);

  store.db.close();
});

test("evaluates final response evidence claims for dashboard reuse", () => {
  const claims = evaluateEvidenceClaims("Tests passed. Lint is clean, and typecheck passed.", ["bun test"]);

  expect(claims).toContainEqual(
    expect.objectContaining({ id: "test", claimed: true, supported: true, matchingCommand: "bun test" })
  );
  expect(claims).toContainEqual(expect.objectContaining({ id: "lint", claimed: true, supported: false }));
  expect(claims).toContainEqual(expect.objectContaining({ id: "typecheck", claimed: true, supported: false }));
  expect(claims).toContainEqual(expect.objectContaining({ id: "build", claimed: false, supported: false }));
  expect(claimsFinalSuccess("Completed successfully.")).toBe(true);
});

test("accepts missing timestamps", () => {
  const store = openFixture("fixtures/missing-timestamps-session.jsonl");
  analyzeSession(store, "missing-timestamps", defaultConfig);

  expect(getRiskFlags(store, "missing-timestamps")).toEqual([]);

  store.db.close();
});

test("malformed fixture fails with line number", () => {
  expect(() => openFixture("fixtures/malformed-session.jsonl")).toThrow("line 2");
});

function openFixture(path: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-analyzer-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript(path, readFileSync(path, "utf8"));
  ingestTranscript(store, transcript, defaultConfig);
  return store;
}

function openInlineFixture(events: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-analyzer-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript("inline.jsonl", events.map((event) => JSON.stringify(event)).join("\n"));
  ingestTranscript(store, transcript, defaultConfig);
  return store;
}

test("checks claims against the whole final response, not the clipped summary", () => {
  const preamble = "I looked at the parser. I read the config. I traced the store. I compared both adapters. I wrote a fixture. I reran the suite.";
  const store = openInlineFixture([
    { schemaVersion: "agentops.event.v1", type: "session", id: "long-final" },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "final_response", content: `${preamble} Tests passed and lint is clean.` }
  ]);
  analyzeSession(store, "long-final", defaultConfig);

  expect(getRiskFlags(store, "long-final").map((flag) => flag.category)).toContain("missing-lint-evidence");
  store.db.close();
});

test("checks the full final-response content even when the producer supplies a short summary", () => {
  const filler = "I traced the store and compared both adapters. ".repeat(40);
  const store = openInlineFixture([
    { schemaVersion: "agentops.event.v1", type: "session", id: "summary-final" },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "final_response", summary: "Work is complete.", content: `${filler} Tests passed and lint is clean.` }
  ]);
  analyzeSession(store, "summary-final", defaultConfig);

  expect(getRiskFlags(store, "summary-final").map((flag) => flag.category)).toContain("missing-lint-evidence");
  store.db.close();
});

for (const [name, final] of [
  ["past 1,000 characters", `Final: ${"I traced the store and compared both adapters. ".repeat(40)} Tests passed and lint is clean.`],
  ["on a continuation line", "Final: Tests passed.\nLint is clean."]
] as const) {
  test(`plain-text import checks a claim ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-analyzer-test-"));
    const store = openStore(join(dir, "agentops.db"));
    const transcript = parseForensicTextTranscript("terminal.txt", ["$ bun test", "exit code 0", final].join("\n"));
    ingestTranscript(store, transcript, defaultConfig);
    analyzeSession(store, transcript.session.id, defaultConfig);

    expect(getRiskFlags(store, transcript.session.id).map((flag) => flag.category)).toContain("missing-lint-evidence");
    store.db.close();
  });
}
