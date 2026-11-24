import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadAdapterInput, resolveAdapter } from "../src/adapters";
import { getDashboardSession } from "../src/dashboardData";
import { resolveAdapter } from "../src/adapters";
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

test.each([
  ["echo bun test", "failed"],
  ["make test --just-print", "failed"],
  ["MAKEFLAGS=n make test", "failed"],
  ["make -kn test", "failed"],
  ["make -f test", "failed"],
  ["gmake -C project test", "passed"],
  ["mvn clean test", "passed"],
  ["make test", "passed"],
  ["make -j4 test", "passed"],
  ["CI=1 bun test unit.test.ts", "passed"]
])("checks the recorded invocation %s for both verification gates", (command, status) => {
  const store = openInlineFixture([
    { schemaVersion: "agentops.event.v1", type: "session", id: "command-shape" },
    { schemaVersion: "agentops.event.v1", type: "command", command, status: "completed", exitCode: 0 }
  ]);
  try {
    const config = { ...defaultConfig, gates: { ...defaultConfig.gates, requiredVerificationCommands: ["test"] } };
    const result = evaluateQualityGate(store, "command-shape", config);
    for (const id of ["required-verification", "required-command:test"]) {
      expect(result.checks).toContainEqual(expect.objectContaining({ id, status }));
    }
  } finally {
    store.db.close();
  }
});

test.each([
  ["/bin/zsh -lc 'bun test'", "passed"],
  ["/bin/zsh -lc 'cd packages/core && bun test'", "passed"],
  ["bash -lc 'bun test 2>&1 | tail -20'", "passed"],
  ['bun test "src/a b.test.ts"', "passed"],
  ["env CI=1 bun test", "passed"],
  ["timeout 600 bun test", "passed"],
  ["bun run lint; bun test", "passed"],
  ["/bin/zsh -lc 'echo bun test'", "failed"],
  ["bash -lc 'make test --just-print | tail -1'", "failed"],
  ["true || bun test", "failed"],
  ['echo "cd core && bun test"', "failed"]
])("classifies recorded Codex shell invocation %s", (command, status) => {
  const store = openInlineFixture([
    { type: "thread.started", thread_id: "codex-shell" },
    { type: "item.completed", item: { id: "run", type: "command_execution", command, status: "completed", exit_code: 0 } }
  ]);
  try {
    const config = { ...defaultConfig, gates: { ...defaultConfig.gates, requiredVerificationCommands: ["test"] } };
    const { checks } = evaluateQualityGate(store, "codex-shell", config);
    for (const id of ["required-verification", "required-command:test"]) {
      expect(checks).toContainEqual(expect.objectContaining({ id, status }));
    }
  } finally {
    store.db.close();
  }
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
  const input = { sourcePath: "gate-inline.jsonl", content: events.map((event) => JSON.stringify(event)).join("\n") };
  const transcript = resolveAdapter(input).parse(input, defaultConfig);
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

for (const fixture of ["claude-code-stream-partial-session", "codex-exec-partial-session"]) {
  test(`${fixture}: an unfinished verification is visible but satisfies neither requirement`, () => {
    const input = loadAdapterInput(`fixtures/${fixture}.jsonl`);
    const config = { ...defaultConfig, gates: { ...defaultConfig.gates, requiredVerificationCommands: ["test"] } };
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-partial-run-")), "agentops.db"));
    try {
      const { sessionId } = ingestTranscript(store, resolveAdapter(input).parse(input, config), config);
      analyzeSession(store, sessionId, config);
      const gate = evaluateQualityGate(store, sessionId, config);
      for (const id of ["required-verification", "required-command:test"]) {
        expect(gate.checks.find(check => check.id === id)).toMatchObject({ status: "failed", observed: 0 });
      }
      const detail = getDashboardSession(store, sessionId, config)!;
      expect(detail.commands.map(command => command.command)).toContain("bun test");
      expect(detail.decision.mergeReadiness).toMatchObject({ status: "blocked", verificationCount: 0 });
      expect(detail.decision.mergeReadiness.reasons).toContain('No observed verification command containing "test" was recorded.');
      expect(getDashboardSession(store, sessionId, defaultConfig)?.decision.mergeReadiness.status).toBe("needs-review");
      expect(detail.decision.evidence.find(row => row.id === "test")?.evidenceFound).toBe(false);
    } finally {
      store.db.close();
    }
  });
}

test("recorded failures are visible separately from a missing result, and a subsequent pass recovers", () => {
  const session = { schemaVersion: "agentops.event.v1", type: "session", id: "outcomes" };
  const shell = { type: "command", command: "bun test" };
  const failed = { ...shell, status: "failed", exitCode: 1 };
  const passed = { ...shell, status: "completed", exitCode: 0 };
  for (const [runs, expected] of [[[failed], "failed"], [[failed, passed], "verified"]] as const) {
    const store = openInlineFixture([session, ...runs]);
    try {
      const gate = evaluateQualityGate(store, session.id);
      const check = gate.checks.find(row => row.id === "required-verification");
      expect(check).toMatchObject({ status: "passed", observed: runs.length });
      expect(check?.message).toContain("1 failed.");
      const decision = getDashboardSession(store, session.id, defaultConfig)!.decision;
      expect(decision.evidence.find(row => row.id === "test")?.status).toBe(expected);
      expect(decision.mergeReadiness.status).toBe(expected === "failed" ? "needs-review" : "ready");
    } finally {
      store.db.close();
    }
  }
});
