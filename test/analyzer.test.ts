import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
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
