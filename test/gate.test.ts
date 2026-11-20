import { getClaimsLedger } from "../src/ledger";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig, type AgentOpsConfig } from "../src/config";
import { evaluateQualityGate, formatGateGithub, formatGateJson, formatGateText } from "../src/gate";
import { parseJsonlTranscript } from "../src/parser";
import { ingestTranscript, openStore } from "../src/store";

test("passes quality gate for verified low-risk sessions", () => {
  const store = openFixture("fixtures/sample-session.jsonl");
  analyzeSession(store, "sample-session", defaultConfig);

  const result = evaluateQualityGate(store, "sample-session", defaultConfig);

  expect(result.status).toBe("passed");
  expect(result.checks.every((check) => check.status === "passed")).toBe(true);
  expect(formatGateText(result)).toContain("Status: PASSED");
  expect(formatGateGithub(result)).toContain("PASS PASSED");
  expect(JSON.parse(formatGateJson(result)).schemaVersion).toBe("agentops.gate.v1");

  store.db.close();
});

test("fails quality gate for high risks and unsupported final claims", () => {
  const store = openFixture("fixtures/risky-session.jsonl");
  analyzeSession(store, "risky-session", defaultConfig);

  const result = evaluateQualityGate(store, "risky-session", defaultConfig);

  expect(result.status).toBe("failed");
  expect(result.checks).toContainEqual(expect.objectContaining({ id: "max-high-risks", status: "failed" }));
  expect(result.checks).toContainEqual(expect.objectContaining({ id: "required-verification", status: "failed" }));
  expect(result.checks).toContainEqual(expect.objectContaining({ id: "unsupported-final-claims", status: "failed" }));

  store.db.close();
});

test("supports required verification commands and generated-file churn gates", () => {
  const store = openInlineFixture([
    { schemaVersion: "agentops.event.v1", type: "session", id: "gate-config" },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "file_edit", path: "src/generated/client.ts", operation: "edit", linesAdded: 4, linesRemoved: 2 },
    { schemaVersion: "agentops.event.v1", type: "final_response", content: "Implemented and tested." }
  ]);
  analyzeSession(store, "gate-config", defaultConfig);
  const config: AgentOpsConfig = {
    ...defaultConfig,
    gates: {
      ...defaultConfig.gates,
      requiredVerificationCommands: ["lint"],
      maxGeneratedFileChurnLines: 5
    }
  };

  const result = evaluateQualityGate(store, "gate-config", config);

  expect(result.status).toBe("failed");
  expect(result.checks).toContainEqual(expect.objectContaining({ id: "required-command:lint", status: "failed" }));
  expect(result.checks).toContainEqual(expect.objectContaining({ id: "generated-file-churn", status: "failed", observed: 6 }));

  store.db.close();
});

function openFixture(path: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-gate-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript(path, readFileSync(path, "utf8"));
  ingestTranscript(store, transcript, defaultConfig);
  return store;
}

function openInlineFixture(events: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-gate-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript("gate-inline.jsonl", events.map((event) => JSON.stringify(event)).join("\n"));
  ingestTranscript(store, transcript, defaultConfig);
  return store;
}

test("denied and declined commands are not verification evidence", () => {
  for (const status of ["denied", "declined"]) {
    const store = openInlineFixture([
      { schemaVersion: "agentops.event.v1", type: "session", id: `gate-${status}` },
      { schemaVersion: "agentops.event.v1", type: "tool_call", command: "bun test", status },
      { schemaVersion: "agentops.event.v1", type: "final_response", content: "Implemented; tests pass." }
    ]);
    analyzeSession(store, `gate-${status}`, defaultConfig);
    const result = evaluateQualityGate(store, `gate-${status}`, defaultConfig);

    expect(result.status).toBe("failed");
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "required-verification", status: "failed" }));
    store.db.close();
  }
});

test("checks the current sensitive path policy against an already imported session", () => {
  const store = openFixture("fixtures/sample-session.jsonl");
  try {
    analyzeSession(store, "sample-session", defaultConfig);
    const policy = { ...defaultConfig, risk: { ...defaultConfig.risk, sensitivePaths: ["src/server.ts"] } };
    expect(evaluateQualityGate(store, "sample-session", policy).checks).toContainEqual(
      expect.objectContaining({ id: "max-high-risks", status: "failed" })
    );
    expect(evaluateQualityGate(store, "sample-session", defaultConfig).status).toBe("passed");
  } finally {
    store.db.close();
  }
});

test("legacy Claude imports require re-import before their old completed markers can verify a session", () => {
  const store = openInlineFixture([
    { type: "session", id: "legacy" },
    { type: "tool_call", command: "bun test", status: "completed" },
    { type: "final_response", content: "Tests passed." }
  ]);
  try {
    store.db.query("UPDATE sessions SET source_adapter = 'claude-code-stream-json' WHERE id = 'legacy'").run();
    const gate = evaluateQualityGate(store, "legacy", defaultConfig);
    expect(gate.status).toBe("failed");
    expect(getClaimsLedger(store, "legacy").claims.find((claim) => claim.id === "test")?.verdict).toBe("unsupported");
    expect(gate.checks.find((check) => check.id === "required-verification")?.message).toContain("Re-import");
  } finally {
    store.db.close();
  }
});
