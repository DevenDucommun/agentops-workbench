import { readFileSync } from "node:fs";
import { evaluateQualityGate, formatGateJson, formatGateText } from "./gate";
import { getGitChanges } from "./git";
import { generateSessionInspection } from "./inspect";
import { generateGithubRepoComment, generateMarkdownRepoReport, generateMarkdownReport } from "./report";
import { getSession, getSessionId, listSessions, openStore, type Store } from "./store";
import { loadConfig } from "./config";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type McpOptions = {
  configPath?: string;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonValue;
  isError?: boolean;
};

const protocolVersion = "2025-06-18";

const tools = [
  {
    name: "agentops_list_sessions",
    title: "List AgentOps sessions",
    description: "List recent AgentOps sessions from the local SQLite store.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum sessions to return. Defaults to 20."
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "agentops_inspect_session",
    title: "Inspect an AgentOps session",
    description: "Return the compact AgentOps session inspection view for a session.",
    inputSchema: sessionInputSchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "agentops_session_report",
    title: "Render an AgentOps session report",
    description: "Return the Markdown session report for a session.",
    inputSchema: sessionInputSchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "agentops_quality_gate",
    title: "Evaluate an AgentOps quality gate",
    description: "Evaluate deterministic quality gates for a session and return text or JSON.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session id to inspect. Use latest or omit for the newest session."
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Output format. Defaults to text."
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "agentops_repo_report",
    title: "Render an AgentOps repo report",
    description: "Return a repo-aware AgentOps report for a session using the current git diff.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session id to inspect. Use latest or omit for the newest session."
        },
        format: {
          type: "string",
          enum: ["markdown", "github"],
          description: "Output format. Defaults to markdown."
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  }
] as const;

export async function startMcpStdio(options: McpOptions = {}): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";

  return new Promise((resolve) => {
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (raw) writeMcpResponse(raw, options);
        newline = buffer.indexOf("\n");
      }
    });
    process.stdin.on("end", () => {
      const raw = buffer.trim();
      if (raw) writeMcpResponse(raw, options);
      resolve();
    });
  });
}

export function handleMcpMessage(raw: string, options: McpOptions = {}): string | null {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return JSON.stringify(errorResponse(null, -32700, "Parse error"));
  }

  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return JSON.stringify(errorResponse(request.id ?? null, -32600, "Invalid Request"));
  }

  if (request.id === undefined) return null;

  try {
    const result = handleMcpRequest(request, options);
    return JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(errorResponse(request.id, -32603, message));
  }
}

function writeMcpResponse(raw: string, options: McpOptions): void {
  const response = handleMcpMessage(raw, options);
  if (response) process.stdout.write(`${response}\n`);
}

function handleMcpRequest(request: JsonRpcRequest, options: McpOptions): JsonValue {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "agentops-workbench",
          version: packageVersion()
        }
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools as unknown as JsonValue };
    case "tools/call":
      return callTool(request.params, options) as unknown as JsonValue;
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

function callTool(params: unknown, options: McpOptions): ToolResult {
  const record = requireRecord(params, "tools/call params");
  const name = readRequiredString(record, "name");
  const args = readRecord(record.arguments, "arguments");

  switch (name) {
    case "agentops_list_sessions":
      return listSessionsTool(args);
    case "agentops_inspect_session":
      return sessionTextTool(args, options, "inspect");
    case "agentops_session_report":
      return sessionTextTool(args, options, "report");
    case "agentops_quality_gate":
      return qualityGateTool(args, options);
    case "agentops_repo_report":
      return repoReportTool(args, options);
    default:
      return {
        content: [{ type: "text", text: `Unknown AgentOps MCP tool: ${name}` }],
        isError: true
      };
  }
}

function listSessionsTool(args: Record<string, unknown>): ToolResult {
  const limit = readInteger(args.limit, 20, 1, 100, "limit");
  return withStore((store) => {
    const sessions = listSessions(store, limit);
    return {
      content: [{ type: "text", text: JSON.stringify({ sessions }, null, 2) }],
      structuredContent: { sessions: sessions as unknown as JsonValue }
    };
  });
}

function sessionTextTool(args: Record<string, unknown>, options: McpOptions, kind: "inspect" | "report"): ToolResult {
  const sessionArg = readOptionalString(args.sessionId) ?? "latest";
  const config = loadConfig(options.configPath ?? "agentops.config.json");
  return withStore((store) => {
    const sessionId = resolveSessionId(store, sessionArg);
    const session = getSession(store, sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const text = kind === "inspect" ? generateSessionInspection(store, sessionId, config) : generateMarkdownReport(store, sessionId, config);
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        sessionId,
        sourceAdapter: session.source_adapter,
        agent: session.agent,
        task: session.task
      }
    };
  });
}

function qualityGateTool(args: Record<string, unknown>, options: McpOptions): ToolResult {
  const sessionArg = readOptionalString(args.sessionId) ?? "latest";
  const format = readOptionalString(args.format) ?? "text";
  if (format !== "text" && format !== "json") throw new Error("format must be text or json");
  const config = loadConfig(options.configPath ?? "agentops.config.json");
  return withStore((store) => {
    const sessionId = resolveSessionId(store, sessionArg);
    const result = evaluateQualityGate(store, sessionId, config, { gitChanges: getGitChangesOrEmpty() });
    const text = format === "json" ? formatGateJson(result) : formatGateText(result);
    return {
      content: [{ type: "text", text }],
      structuredContent: result as unknown as JsonValue,
      isError: result.status === "failed"
    };
  });
}

function repoReportTool(args: Record<string, unknown>, options: McpOptions): ToolResult {
  const sessionArg = readOptionalString(args.sessionId) ?? "latest";
  const format = readOptionalString(args.format) ?? "markdown";
  if (format !== "markdown" && format !== "github") throw new Error("format must be markdown or github");
  const config = loadConfig(options.configPath ?? "agentops.config.json");
  return withStore((store) => {
    const sessionId = resolveSessionId(store, sessionArg);
    const gitChanges = getGitChangesOrEmpty();
    const text =
      format === "github"
        ? generateGithubRepoComment(store, sessionId, gitChanges, config)
        : generateMarkdownRepoReport(store, sessionId, gitChanges, config);
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        sessionId,
        format,
        gitChangedFiles: gitChanges.length
      }
    };
  });
}

function withStore<T>(callback: (store: Store) => T): T {
  const store = openStore();
  try {
    return callback(store);
  } finally {
    store.db.close();
  }
}

function resolveSessionId(store: Store, requested: string): string {
  const sessionId = getSessionId(store, requested);
  if (!sessionId) throw new Error("No AgentOps sessions found. Run agentops demo, agentops audit <artifact>, or agentops run codex|claude <prompt>.");
  return sessionId;
}

function getGitChangesOrEmpty() {
  try {
    return getGitChanges();
  } catch {
    return [];
  }
}

function sessionInputSchema() {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Session id to inspect. Use latest or omit for the newest session."
      }
    },
    additionalProperties: false
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return requireRecord(value, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") throw new Error("string value must be non-empty");
  return value;
}

function readInteger(value: unknown, defaultValue: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function errorResponse(id: string | number | null | undefined, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
