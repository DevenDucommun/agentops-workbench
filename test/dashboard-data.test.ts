import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runCli } from "../src/cli";
import { defaultConfig } from "../src/config";
import { getDashboardComparison, getDashboardSession } from "../src/dashboardData";
import { openStore } from "../src/store";

const originalDb = process.env.AGENTOPS_DB;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-dashboard-data-test-"));
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
});

afterEach(() => {
  if (originalDb === undefined) {
    delete process.env.AGENTOPS_DB;
  } else {
    process.env.AGENTOPS_DB = originalDb;
  }
});

async function ingest(...fixtures: string[]): Promise<void> {
  for (const fixture of fixtures) {
    const result = await runCli(["audit", fixture, "--quiet"]);
    expect(result.exitCode).toBe(0);
  }
}

test("buildDashboardDecision marks a clean session ready", async () => {
  await ingest("fixtures/sample-session.jsonl");
  const store = openStore();
  const detail = getDashboardSession(store, "sample-session", defaultConfig);
  store.db.close();

  expect(detail).not.toBeNull();
  expect(detail!.decision.mergeReadiness.status).toBe("ready");
  expect(detail!.decision.mergeReadiness.highRiskCount).toBe(0);
  expect(detail!.decision.evidence.length).toBeGreaterThan(0);
});

test("buildDashboardDecision blocks a risky session with reasons", async () => {
  await ingest("fixtures/risky-session.jsonl");
  const store = openStore();
  const detail = getDashboardSession(store, "risky-session", defaultConfig);
  store.db.close();

  expect(detail).not.toBeNull();
  expect(detail!.decision.mergeReadiness.status).toBe("blocked");
  expect(detail!.decision.mergeReadiness.highRiskCount).toBeGreaterThan(0);
  expect(detail!.decision.mergeReadiness.reasons.length).toBeGreaterThan(0);
});

test("buildEvidenceQuality distinguishes structured JSONL from forensic text", async () => {
  await ingest("fixtures/sample-session.jsonl", "fixtures/forensic-terminal-transcript.txt");
  const store = openStore();
  const structured = getDashboardSession(store, "sample-session", defaultConfig);
  const forensic = getDashboardSession(store, "forensic-terminal-transcript", defaultConfig);
  store.db.close();

  expect(structured!.evidenceQuality.level).toBe("structured");
  expect(forensic!.evidenceQuality.level).toBe("forensic");
  expect(forensic!.evidenceQuality.notes.join(" ")).toContain("inferred");
});

test("buildRiskDrilldown groups risks and keeps totals consistent", async () => {
  await ingest("fixtures/risky-session.jsonl");
  const store = openStore();
  const detail = getDashboardSession(store, "risky-session", defaultConfig);
  store.db.close();

  const drill = detail!.riskDrilldown;
  expect(drill.totals.total).toBeGreaterThan(0);

  // Every group's declared count matches its item list, and items carry the group's severity.
  const summed = drill.groups.reduce((acc, group) => {
    expect(group.count).toBe(group.risks.length);
    for (const risk of group.risks) expect(risk.severity).toBe(group.severity);
    return acc + group.count;
  }, 0);
  expect(summed).toBe(drill.totals.total);

  const highFromGroups = drill.groups
    .filter((group) => group.severity === "high")
    .reduce((acc, group) => acc + group.count, 0);
  expect(highFromGroups).toBe(drill.totals.high);
});

test("getDashboardComparison reports deltas between two sessions", async () => {
  await ingest("fixtures/sample-session.jsonl", "fixtures/risky-session.jsonl");
  const store = openStore();
  const comparison = getDashboardComparison(store, "sample-session", "risky-session", defaultConfig);
  store.db.close();

  expect(comparison).not.toBeNull();
  expect(comparison!.base.id).toBe("sample-session");
  expect(comparison!.target.id).toBe("risky-session");
  // risky-session has more high-severity risks than the clean sample.
  expect(comparison!.deltas.highRiskCount).toBeGreaterThan(0);
});
