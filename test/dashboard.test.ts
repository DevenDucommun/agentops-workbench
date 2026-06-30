import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runCli } from "../src/cli";
import { startDashboardServer } from "../src/dashboard";

const originalDb = process.env.AGENTOPS_DB;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-dashboard-test-"));
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
});

afterEach(() => {
  if (originalDb === undefined) {
    delete process.env.AGENTOPS_DB;
  } else {
    process.env.AGENTOPS_DB = originalDb;
  }
});

test("dashboard API reads sessions from SQLite", async () => {
  const ingest = await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const sessionsResponse = await fetch(`${server.url}/api/sessions`);
    expect(sessionsResponse.status).toBe(200);
    const sessionsPayload = (await sessionsResponse.json()) as { sessions: Array<{ id: string; totalTokens: number | null }> };
    expect(sessionsPayload.sessions).toHaveLength(1);
    expect(sessionsPayload.sessions[0].id).toBe("sample-session");

    const detailResponse = await fetch(`${server.url}/api/sessions/sample-session`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      session: { id: string };
      evidenceQuality: {
        level: string;
        label: string;
        observedCommandCount: number;
        inferredCommandCount: number;
        inferredFileCount: number;
      };
      usage: { totalTokens: number | null };
      events: unknown[];
      commands: unknown[];
      files: unknown[];
      risks: unknown[];
      verification: unknown[];
      decision: {
        mergeReadiness: { status: string; missingEvidenceCount: number; verificationCount: number };
        evidence: Array<{ id: string; status: string; command: string | null }>;
      };
    };
    expect(detailPayload.session.id).toBe("sample-session");
    expect(detailPayload.evidenceQuality).toEqual(
      expect.objectContaining({
        level: "structured",
        label: "Structured JSONL",
        observedCommandCount: 2,
        inferredCommandCount: 0,
        inferredFileCount: 0
      })
    );
    expect(detailPayload.events.length).toBeGreaterThan(0);
    expect(detailPayload.commands.length).toBeGreaterThan(0);
    expect(detailPayload.files.length).toBeGreaterThan(0);
    expect(detailPayload.risks).toEqual([]);
    expect(detailPayload.verification.length).toBeGreaterThan(0);
    expect(detailPayload.decision.mergeReadiness.status).toBe("ready");
    expect(detailPayload.decision.mergeReadiness.missingEvidenceCount).toBe(0);
    expect(detailPayload.decision.mergeReadiness.verificationCount).toBeGreaterThan(0);
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({ id: "test", status: "verified", command: "bun test" })
    );
  } finally {
    server.stop();
  }
});

test("dashboard decision payload surfaces missing evidence and blocked readiness", async () => {
  const ingest = await runCli(["audit", "fixtures/risky-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/risky-session`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      decision: {
        mergeReadiness: { status: string; highRiskCount: number; missingEvidenceCount: number };
        evidence: Array<{ id: string; claimed: boolean; status: string; riskCategory: string | null }>;
      };
      riskDrilldown: {
        totals: { high: number; medium: number; low: number; total: number };
        groups: Array<{
          severity: string;
          category: string;
          count: number;
          risks: Array<{
            command: { command: string } | null;
            file: { path: string; linesAdded: number | null; linesRemoved: number | null } | null;
            evidence: { id: string; status: string } | null;
          }>;
        }>;
      };
    };

    expect(detailPayload.decision.mergeReadiness.status).toBe("blocked");
    expect(detailPayload.decision.mergeReadiness.highRiskCount).toBeGreaterThan(0);
    expect(detailPayload.decision.mergeReadiness.missingEvidenceCount).toBe(1);
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({
        id: "final-success",
        claimed: true,
        status: "missing-evidence",
        riskCategory: "unsupported-success-claim"
      })
    );
    expect(detailPayload.riskDrilldown.totals).toEqual({ high: 2, medium: 3, low: 0, total: 5 });
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "high",
        category: "destructive-command",
        count: 1,
        risks: [expect.objectContaining({ command: expect.objectContaining({ command: "rm -rf ./dist" }) })]
      })
    );
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "high",
        category: "sensitive-file",
        risks: [expect.objectContaining({ file: expect.objectContaining({ path: ".env" }) })]
      })
    );
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        category: "large-churn",
        risks: [
          expect.objectContaining({
            file: expect.objectContaining({ path: "deploy/production.yaml", linesAdded: 600, linesRemoved: 25 })
          })
        ]
      })
    );
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        category: "unsupported-success-claim",
        risks: [expect.objectContaining({ evidence: expect.objectContaining({ id: "final-success", status: "missing-evidence" }) })]
      })
    );
  } finally {
    server.stop();
  }
});

test("dashboard demo fixtures cover ready, needs-review, and blocked states", async () => {
  for (const fixture of ["fixtures/sample-session.jsonl", "fixtures/needs-review-session.jsonl", "fixtures/risky-session.jsonl"]) {
    const ingest = await runCli(["audit", fixture, "--quiet"]);
    expect(ingest.exitCode).toBe(0);
  }

  const server = startDashboardServer({ port: 0 });
  try {
    const ready = (await fetch(`${server.url}/api/sessions/sample-session`).then((response) => response.json())) as {
      decision: { mergeReadiness: { status: string } };
    };
    const needsReview = (await fetch(`${server.url}/api/sessions/needs-review-session`).then((response) => response.json())) as {
      decision: { mergeReadiness: { status: string; missingEvidenceCount: number }; evidence: Array<{ id: string; status: string }> };
    };
    const blocked = (await fetch(`${server.url}/api/sessions/risky-session`).then((response) => response.json())) as {
      decision: { mergeReadiness: { status: string } };
    };

    expect(ready.decision.mergeReadiness.status).toBe("ready");
    expect(needsReview.decision.mergeReadiness.status).toBe("needs-review");
    expect(needsReview.decision.mergeReadiness.missingEvidenceCount).toBe(1);
    expect(needsReview.decision.evidence).toContainEqual(expect.objectContaining({ id: "final-success", status: "missing-evidence" }));
    expect(blocked.decision.mergeReadiness.status).toBe("blocked");
  } finally {
    server.stop();
  }
});

test("dashboard API includes tool usage summary", async () => {
  const ingest = await runCli(["audit", "fixtures/codex-exec-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/codex-exec-sample`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      tools: Array<{ toolName: string; category: string; count: number }>;
    };

    expect(hasTool(detailPayload.tools, "shell", "shell", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "mcp__repo__read_file", "mcp", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "web_search", "web", 1)).toBe(true);
  } finally {
    server.stop();
  }
});

test("dashboard API includes Claude stream tool usage summary", async () => {
  const ingest = await runCli(["audit", "fixtures/claude-code-stream-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/claude-stream-sample`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      tools: Array<{ toolName: string; category: string; count: number }>;
    };

    expect(hasTool(detailPayload.tools, "Bash", "shell", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "Edit", "file", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "mcp__repo__read_file", "mcp", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "WebSearch", "web", 1)).toBe(true);
  } finally {
    server.stop();
  }
});

function hasTool(tools: Array<{ toolName: string; category: string; count: number }>, toolName: string, category: string, count: number): boolean {
  return tools.some((tool) => tool.toolName === toolName && tool.category === category && tool.count === count);
}

test("dashboard serves local HTML shell and 404s missing sessions", async () => {
  const server = startDashboardServer({ port: 0 });
  try {
    const htmlResponse = await fetch(server.url);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    const html = await htmlResponse.text();
    expect(html).toContain("AgentOps Workbench");
    expect(html).toContain("session-filter");
    expect(html).toContain("adapter-filter");
    expect(html).toContain("report-link");
    expect(html).toContain("Markdown report");
    expect(html).toContain("evidence-link");
    expect(html).toContain("JSON evidence");
    expect(html).toContain("compare-select");
    expect(html).toContain("Compare with");
    expect(html).toContain("Run Comparison");
    expect(html).toContain("Merge Readiness");
    expect(html).toContain("Evidence Quality");
    expect(html).toContain("Claim vs Evidence");
    expect(html).toContain("Risk Drilldown");

    const missingResponse = await fetch(`${server.url}/api/sessions/missing-session`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "Session not found" });
  } finally {
    server.stop();
  }
});

test("dashboard serves sanitized JSON evidence bundles for sessions", async () => {
  const ingest = await runCli(["audit", "fixtures/risky-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const evidenceResponse = await fetch(`${server.url}/api/sessions/risky-session/evidence`);
    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.headers.get("content-type")).toContain("application/json");
    expect(evidenceResponse.headers.get("content-disposition")).toContain('filename="risky-session-evidence.json"');
    const payload = (await evidenceResponse.json()) as {
      schemaVersion: string;
      kind: string;
      session: { id: string; source_path?: string; sourcePath?: string };
      evidenceQuality: { level: string; label: string };
      decision: { mergeReadiness: { status: string }; evidence: unknown[] };
      riskDrilldown: { totals: { total: number } };
      verification: Array<{ command: string; output?: string }>;
      commands: Array<{ command: string; output?: string }>;
      events: Array<{ summary: string; rawJson?: string; rawPayloadHash?: string }>;
    };

    expect(payload.schemaVersion).toBe("agentops.evidence.v1");
    expect(payload.kind).toBe("session-evidence");
    expect(payload.session.id).toBe("risky-session");
    expect(payload.session.source_path).toBeUndefined();
    expect(payload.session.sourcePath).toBeUndefined();
    expect(payload.evidenceQuality).toEqual(expect.objectContaining({ level: "structured", label: "Structured JSONL" }));
    expect(payload.decision.mergeReadiness.status).toBe("blocked");
    expect(payload.decision.evidence.length).toBeGreaterThan(0);
    expect(payload.riskDrilldown.totals.total).toBe(5);
    expect(payload.commands).toContainEqual(expect.objectContaining({ command: "rm -rf ./dist" }));
    expect(payload.commands.every((command) => command.output === undefined)).toBe(true);
    expect(payload.events.every((event) => event.rawJson === undefined && event.rawPayloadHash === undefined)).toBe(true);
    expect(payload.events.map((event) => event.summary)).toContain("Completed successfully.");

    const missingEvidence = await fetch(`${server.url}/api/sessions/missing-session/evidence`);
    expect(missingEvidence.status).toBe(404);
    expect(await missingEvidence.json()).toEqual({ error: "Session not found" });
  } finally {
    server.stop();
  }
});

test("dashboard labels forensic text evidence quality", async () => {
  const ingest = await runCli(["audit", "fixtures/forensic-terminal-transcript.txt", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/forensic-terminal-transcript`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      evidenceQuality: {
        level: string;
        label: string;
        sourceAdapter: string | null;
        observedCommandCount: number;
        inferredCommandCount: number;
        inferredFileCount: number;
        notes: string[];
      };
      commands: Array<{ command: string; status: string | null }>;
      files: Array<{ path: string; operation: string }>;
      risks: Array<{ category: string }>;
    };

    expect(detailPayload.evidenceQuality).toEqual(
      expect.objectContaining({
        level: "forensic",
        label: "Forensic text",
        sourceAdapter: "forensic-text",
        observedCommandCount: 2,
        inferredCommandCount: 0,
        inferredFileCount: 2
      })
    );
    expect(detailPayload.evidenceQuality.notes.join(" ")).toContain("inferred");
    expect(detailPayload.commands).toContainEqual(expect.objectContaining({ command: "bun test", status: "observed" }));
    expect(detailPayload.files).toContainEqual(expect.objectContaining({ path: "src/server.ts", operation: "inferred edit" }));
    expect(detailPayload.risks).toContainEqual(expect.objectContaining({ category: "forensic-import" }));

    const evidenceResponse = await fetch(`${server.url}/api/sessions/forensic-terminal-transcript/evidence`);
    expect(evidenceResponse.status).toBe(200);
    const evidencePayload = (await evidenceResponse.json()) as { evidenceQuality: { level: string; label: string } };
    expect(evidencePayload.evidenceQuality).toEqual(expect.objectContaining({ level: "forensic", label: "Forensic text" }));
  } finally {
    server.stop();
  }
});

test("dashboard distinguishes inferred forensic evidence from verified evidence", async () => {
  const ingest = await runCli(["audit", "fixtures/forensic-copied-chat.txt", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/forensic-copied-chat`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      evidenceQuality: {
        level: string;
        inferredCommandCount: number;
        inferredFileCount: number;
      };
      decision: {
        mergeReadiness: { status: string; reasons: string[]; missingEvidenceCount: number; verificationCount: number };
        evidence: Array<{ id: string; status: string; command: string | null; commandStatus: string | null }>;
      };
      commands: Array<{ command: string; status: string | null }>;
    };

    expect(detailPayload.evidenceQuality).toEqual(
      expect.objectContaining({
        level: "forensic",
        inferredCommandCount: 2,
        inferredFileCount: 1
      })
    );
    expect(detailPayload.commands).toContainEqual(expect.objectContaining({ command: "bun test", status: "inferred" }));
    expect(detailPayload.decision.mergeReadiness.status).toBe("needs-review");
    expect(detailPayload.decision.mergeReadiness.reasons.join(" ")).toContain("inferred command evidence");
    expect(detailPayload.decision.mergeReadiness.missingEvidenceCount).toBe(0);
    expect(detailPayload.decision.mergeReadiness.verificationCount).toBe(1);
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({ id: "test", status: "inferred-evidence", command: "bun test", commandStatus: "inferred" })
    );
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({ id: "final-success", status: "inferred-evidence", command: "bun test", commandStatus: "inferred" })
    );
  } finally {
    server.stop();
  }
});

test("dashboard compares two sessions with decision and evidence deltas", async () => {
  const riskyIngest = await runCli(["audit", "fixtures/risky-session.jsonl", "--quiet"]);
  expect(riskyIngest.exitCode).toBe(0);
  const sampleIngest = await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"]);
  expect(sampleIngest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const compareResponse = await fetch(`${server.url}/api/compare?base=risky-session&target=sample-session`);
    expect(compareResponse.status).toBe(200);
    const comparison = (await compareResponse.json()) as {
      schemaVersion: string;
      kind: string;
      compatible: { sameRepo: boolean; message: string | null };
      base: { id: string; readiness: string; riskCount: number; verificationCount: number };
      target: { id: string; readiness: string; riskCount: number; verificationCount: number };
      deltas: { riskCount: number; highRiskCount: number; verificationCount: number; fileCount: number };
      risks: Array<{ severity: string; category: string; baseCount: number; targetCount: number; delta: number }>;
      files: { baseOnly: string[]; targetOnly: string[]; common: string[] };
      verification: { baseOnly: string[]; targetOnly: string[]; common: string[] };
    };

    expect(comparison.schemaVersion).toBe("agentops.comparison.v1");
    expect(comparison.kind).toBe("session-comparison");
    expect(comparison.compatible).toEqual({ sameRepo: true, message: null });
    expect(comparison.base).toEqual(expect.objectContaining({ id: "risky-session", readiness: "blocked", riskCount: 5, verificationCount: 0 }));
    expect(comparison.target).toEqual(expect.objectContaining({ id: "sample-session", readiness: "ready", riskCount: 0, verificationCount: 1 }));
    expect(comparison.deltas).toEqual(expect.objectContaining({ riskCount: -5, highRiskCount: -2, verificationCount: 1, fileCount: 0 }));
    expect(comparison.risks).toContainEqual(
      expect.objectContaining({ severity: "high", category: "destructive-command", baseCount: 1, targetCount: 0, delta: -1 })
    );
    expect(comparison.files.baseOnly).toContain(".env");
    expect(comparison.files.targetOnly).toContain("src/server.ts");
    expect(comparison.verification.targetOnly).toContain("bun test");

    const missingCompare = await fetch(`${server.url}/api/compare?base=risky-session&target=missing-session`);
    expect(missingCompare.status).toBe(404);
    expect(await missingCompare.json()).toEqual({ error: "Session not found" });

    const sameCompare = await fetch(`${server.url}/api/compare?base=risky-session&target=risky-session`);
    expect(sameCompare.status).toBe(400);
    expect(await sameCompare.json()).toEqual({ error: "Choose two different sessions" });

    const incompleteCompare = await fetch(`${server.url}/api/compare?base=risky-session`);
    expect(incompleteCompare.status).toBe(400);
    expect(await incompleteCompare.json()).toEqual({ error: "Missing base or target session" });
  } finally {
    server.stop();
  }
});

test("dashboard serves markdown reports for sessions", async () => {
  const ingest = await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const reportResponse = await fetch(`${server.url}/api/sessions/sample-session/report`);
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.headers.get("content-type")).toContain("text/markdown");
    const report = await reportResponse.text();
    expect(report).toContain("# AgentOps Session Report");
    expect(report).toContain("sample-session");
    expect(report).toContain("`bun test`");

    const missingReport = await fetch(`${server.url}/api/sessions/missing-session/report`);
    expect(missingReport.status).toBe(404);
    expect(await missingReport.json()).toEqual({ error: "Session not found" });
  } finally {
    server.stop();
  }
});

test("dashboard CLI check validates local configuration without starting a server", async () => {
  const result = await runCli(["open", "--check", "--port", "4930"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Dashboard configuration OK");
  expect(result.stdout).toContain("Host: 127.0.0.1");
  expect(result.stdout).toContain("Port: 4930");
  expect(result.stdout).toContain("Database:");
});
