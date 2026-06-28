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
    };
    expect(detailPayload.session.id).toBe("sample-session");
    expect(detailPayload.events.length).toBeGreaterThan(0);
    expect(detailPayload.commands.length).toBeGreaterThan(0);
    expect(detailPayload.files.length).toBeGreaterThan(0);
    expect(detailPayload.risks).toEqual([]);
    expect(detailPayload.verification.length).toBeGreaterThan(0);
  } finally {
    server.stop();
  }
});

test("dashboard serves local HTML shell and 404s missing sessions", async () => {
  const server = startDashboardServer({ port: 0 });
  try {
    const htmlResponse = await fetch(server.url);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(await htmlResponse.text()).toContain("AgentOps Workbench");

    const missingResponse = await fetch(`${server.url}/api/sessions/missing-session`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "Session not found" });
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
