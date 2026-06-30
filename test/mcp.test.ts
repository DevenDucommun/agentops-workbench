import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleMcpMessage } from "../src/mcp";
import { runCli } from "../src/cli";

const originalDb = process.env.AGENTOPS_DB;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-mcp-test-"));
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
});

afterEach(() => {
  if (originalDb === undefined) {
    delete process.env.AGENTOPS_DB;
  } else {
    process.env.AGENTOPS_DB = originalDb;
  }
});

test("serves read-only AgentOps MCP tools", async () => {
  const ingest = await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const initialized = request("initialize");
  expect(initialized.result.protocolVersion).toBe("2025-06-18");
  expect(initialized.result.serverInfo?.name).toBe("agentops-workbench");
  expect(initialized.result.capabilities?.tools).toEqual({});

  const listed = request("tools/list");
  const tools = listed.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
  expect(tools.map((tool) => tool.name)).toContain("agentops_list_sessions");
  expect(tools.map((tool) => tool.name)).toContain("agentops_quality_gate");
  expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

  const sessions = callTool("agentops_list_sessions", { limit: 5 });
  expect(sessions.result.structuredContent.sessions[0].id).toBe("sample-session");
  expect(sessions.result.content?.[0]?.text).toContain("sample-session");

  const inspect = callTool("agentops_inspect_session", { sessionId: "sample-session" });
  expect(inspect.result.content?.[0]?.text).toContain("# AgentOps Session Inspection");
  expect(inspect.result.structuredContent.sessionId).toBe("sample-session");

  const gate = callTool("agentops_quality_gate", { sessionId: "sample-session", format: "json" });
  expect(gate.result.structuredContent.schemaVersion).toBe("agentops.gate.v1");
  expect(gate.result.structuredContent.status).toBe("passed");
  expect(gate.result.content?.[0]?.text).toContain("\"status\": \"passed\"");

  const report = callTool("agentops_session_report", { sessionId: "sample-session" });
  expect(report.result.content?.[0]?.text).toContain("# AgentOps Session Report");
});

test("returns MCP errors for malformed requests", () => {
  const parsed = JSON.parse(handleMcpMessage("{not-json") ?? "{}") as { error: { code: number; message: string } };
  expect(parsed.error.code).toBe(-32700);

  const notification = handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  expect(notification).toBeNull();
});

test("runs MCP over the CLI stdio entrypoint", () => {
  const result = spawnSync("bun", ["./src/cli.ts", "mcp"], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
    env: {
      ...process.env,
      AGENTOPS_DB: process.env.AGENTOPS_DB
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const response = JSON.parse(result.stdout.trim()) as { result: { serverInfo: { name: string } } };
  expect(response.result.serverInfo.name).toBe("agentops-workbench");
});

function request(method: string, params?: unknown) {
  return parseResponse(handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: method, method, params })));
}

function callTool(name: string, args: Record<string, unknown>) {
  return request("tools/call", { name, arguments: args });
}

function parseResponse(raw: string | null) {
  if (!raw) throw new Error("Expected MCP response");
  return JSON.parse(raw) as {
    result: {
      protocolVersion?: string;
      capabilities?: { tools?: Record<string, unknown> };
      serverInfo?: { name?: string };
      tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      content?: Array<{ type: "text"; text: string }>;
      structuredContent?: any;
    };
    error?: { code: number; message: string };
  };
}
