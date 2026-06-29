import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession, claimsFinalSuccess, evaluateEvidenceClaims } from "../src/analyzer";
import { defaultConfig, type AgentOpsConfig } from "../src/config";
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
