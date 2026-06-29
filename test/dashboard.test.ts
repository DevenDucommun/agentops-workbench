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
  const ingest = await runCli(["ingest", "fixtures/sample-session.jsonl"]);
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
  const ingest = await runCli(["ingest", "fixtures/risky-session.jsonl"]);
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
  } finally {
    server.stop();
  }
});

test("dashboard API includes tool usage summary", async () => {
  const ingest = await runCli(["ingest", "fixtures/codex-exec-session.jsonl"]);
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
  const ingest = await runCli(["ingest", "fixtures/claude-code-stream-session.jsonl"]);
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
    expect(html).toContain("Merge Readiness");
    expect(html).toContain("Claim vs Evidence");

    const missingResponse = await fetch(`${server.url}/api/sessions/missing-session`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "Session not found" });
  } finally {
    server.stop();
  }
});

test("dashboard serves markdown reports for sessions", async () => {
  const ingest = await runCli(["ingest", "fixtures/sample-session.jsonl"]);
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
  const result = await runCli(["dashboard", "--check", "--port", "4930"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Dashboard configuration OK");
  expect(result.stdout).toContain("Host: 127.0.0.1");
  expect(result.stdout).toContain("Port: 4930");
  expect(result.stdout).toContain("Database:");
});
