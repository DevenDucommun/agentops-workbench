import { basename, resolve } from "node:path";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { redactValue } from "./redaction";
import type { ParsedTranscript, RawEvent, SessionRecord, UsageInput } from "./types";

type CodexRecord = {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: string | { message?: string };
  message?: string;
  _lineNumber?: number;
  [key: string]: unknown;
};

type CodexItem = {
  id?: string;
  type?: string;
  status?: string;
  text?: string;
  command?: string;
  output?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  path?: string;
  file_path?: string;
  filePath?: string;
  operation?: string;
  lines_added?: number;
  lines_removed?: number;
  tool_name?: string;
  name?: string;
  server?: string;
  tool?: string;
  error?: { message?: string } | null;
  changes?: Array<{ path?: string; kind?: string }>;
  items?: Array<{ text?: string; completed?: boolean }>;
  receiver_thread_ids?: string[];
  prompt?: string | null;
  message?: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
  result?: unknown;
  query?: string;
  [key: string]: unknown;
};

type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  cache_write_input_tokens?: number;
  [key: string]: unknown;
};

export function parseCodexExecJsonl(sourcePath: string, input: string, config: AgentOpsConfig = defaultConfig): ParsedTranscript {
  const records = input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseCodexLine(line, index + 1));
  validateCodexRecords(records);

  const threadId = records.find((record) => record.type === "thread.started" && typeof record.thread_id === "string")?.thread_id;
  const fallbackId = basename(sourcePath).replace(/\.[^.]+$/, "") || "codex-exec-session";

  const events = records.flatMap((record) => normalizeRecord(record));
  markLastAssistantMessageAsFinal(events);

  const session: SessionRecord & { id: string; sourcePath: string; sourceAdapter: string } = {
    type: "session",
    schemaVersion: "agentops.event.v1",
    id: threadId ?? fallbackId,
    source: "codex",
    agent: "Codex",
    task: "Codex exec JSONL capture",
    sourcePath: resolve(sourcePath),
    sourceAdapter: "codex-exec-jsonl"
  };

  if (!config.privacy.redactBeforeStore) {
    return { session, events };
  }

  return {
    session: redactValue(session),
    events: events.map((event) => redactValue(event))
  };
}

function parseCodexLine(line: string, lineNumber: number): CodexRecord {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record must be a JSON object");
    }
    return { ...(value as CodexRecord), _lineNumber: lineNumber };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex exec JSONL record on line ${lineNumber}: ${reason}`);
  }
}

function validateCodexRecords(records: CodexRecord[]): void {
  if (!records.length) throw new Error("Unsupported Codex exec JSONL shape: expected JSONL records from `codex exec --json`.");

  const knownTypes = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "error", "item.started", "item.updated", "item.completed"]);
  const knownRecords = records.filter((record) => typeof record.type === "string" && knownTypes.has(record.type));
  if (!knownRecords.length) {
    throw new Error("Unsupported Codex exec JSONL shape: expected thread, turn, item, or error events from `codex exec --json`.");
  }

  const itemTypes = new Set(["item.started", "item.updated", "item.completed"]);
  for (const record of records) {
    if (itemTypes.has(record.type ?? "") && !isRecord(record.item)) {
      throw new Error(`Unsupported Codex exec JSONL record on line ${record._lineNumber ?? "unknown"}: ${record.type} must include an item object.`);
    }
    if (itemTypes.has(record.type ?? "") && typeof record.item?.type !== "string") {
      throw new Error(`Unsupported Codex exec JSONL record on line ${record._lineNumber ?? "unknown"}: item.type must be a string.`);
    }
  }
}

function normalizeRecord(record: CodexRecord): RawEvent[] {
  switch (record.type) {
    case "thread.started":
      return [];
    case "turn.started":
      return [
        {
          schemaVersion: "agentops.event.v1",
          type: "message",
          source: "codex",
          role: "system",
          summary: "Codex turn started."
        }
      ];
    case "turn.completed":
      return [
        {
          schemaVersion: "agentops.event.v1",
          type: "usage",
          source: "codex",
          status: "completed",
          summary: "Codex turn completed.",
          usage: normalizeUsage(record.usage)
        }
      ];
    case "turn.failed":
      return [
        {
          schemaVersion: "agentops.event.v1",
          type: "error",
          source: "codex",
          status: "failed",
          summary: errorSummary(record)
        }
      ];
    case "error":
      return [
        {
          schemaVersion: "agentops.event.v1",
          type: "error",
          source: "codex",
          status: "failed",
          summary: errorSummary(record)
        }
      ];
    case "item.updated":
      // Progress snapshots (e.g. todo_list edits); item.completed carries the final state.
      return [];
    case "item.started":
    case "item.completed":
      return record.item ? normalizeItem(record.item, record.type) : [];
    default:
      return [
        {
          schemaVersion: "agentops.event.v1",
          type: "message",
          source: "codex",
          summary: typeof record.type === "string" ? `Codex event: ${record.type}` : "Codex event"
        }
      ];
  }
}

function normalizeItem(item: CodexItem, recordType: string): RawEvent[] {
  const status = item.status ?? (recordType === "item.started" ? "in_progress" : "completed");

  // Codex 0.16x file_change items list every touched file in `changes`.
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    return item.changes.filter(isRecord).map((change) => ({
      schemaVersion: "agentops.event.v1",
      type: "file_edit",
      source: "codex",
      path: typeof change.path === "string" ? change.path : undefined,
      operation: fileChangeOperation(change.kind),
      status,
      summary: typeof change.path === "string" ? change.path : "Codex file change."
    }));
  }

  return [normalizeSingleItem(item, status)];
}

function normalizeSingleItem(item: CodexItem, status: string): RawEvent {
  switch (item.type) {
    case "agent_message":
      return {
        schemaVersion: "agentops.event.v1",
        type: "message",
        source: "codex",
        role: "assistant",
        content: item.text,
        status,
        summary: item.text ?? "Codex agent message."
      };
    case "reasoning":
      return {
        schemaVersion: "agentops.event.v1",
        type: "plan",
        source: "codex",
        content: item.text,
        status,
        summary: item.text ?? "Codex reasoning update."
      };
    case "plan_update":
      return {
        schemaVersion: "agentops.event.v1",
        type: "plan",
        source: "codex",
        content: item.text,
        status,
        summary: item.text ?? "Codex plan update."
      };
    case "command_execution":
      return {
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        source: "codex",
        toolName: "shell",
        command: item.command,
        input: item.command ? { command: item.command } : undefined,
        output: typeof item.output === "string" ? item.output : typeof item.aggregated_output === "string" ? item.aggregated_output : undefined,
        status,
        exitCode: typeof item.exit_code === "number" ? item.exit_code : undefined,
        summary: item.command ?? "Codex command execution."
      };
    case "file_change":
      return {
        schemaVersion: "agentops.event.v1",
        type: "file_edit",
        source: "codex",
        path: item.path ?? item.file_path ?? item.filePath,
        operation: item.operation ?? "edit",
        linesAdded: typeof item.lines_added === "number" ? item.lines_added : undefined,
        linesRemoved: typeof item.lines_removed === "number" ? item.lines_removed : undefined,
        status,
        summary: item.path ?? item.file_path ?? item.filePath ?? "Codex file change."
      };
    case "mcp_tool_call": {
      const toolName = mcpToolName(item);
      return {
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        source: "codex",
        toolName,
        input: item.arguments ?? item.args,
        output: stringifyOutput(item.result) ?? (typeof item.error?.message === "string" ? item.error.message : undefined),
        status,
        summary: toolName === "mcp" ? "Codex MCP tool call." : toolName
      };
    }
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items.filter(isRecord) : [];
      const text = items
        .map((todo) => `[${todo.completed === true ? "x" : " "}] ${typeof todo.text === "string" ? todo.text : ""}`.trimEnd())
        .join("\n");
      return {
        schemaVersion: "agentops.event.v1",
        type: "plan",
        source: "codex",
        content: text || undefined,
        status,
        summary: items.length ? `Codex plan: ${items.filter((todo) => todo.completed === true).length}/${items.length} steps done.` : "Codex plan update."
      };
    }
    case "collab_tool_call": {
      const tool = typeof item.tool === "string" ? item.tool : "collab";
      const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.length : 0;
      return {
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        source: "codex",
        toolName: `collab:${tool}`,
        status,
        summary: `Codex subagent ${tool}${receivers ? ` (${receivers} agent${receivers === 1 ? "" : "s"})` : ""}.`
      };
    }
    case "error":
      return {
        schemaVersion: "agentops.event.v1",
        type: "error",
        source: "codex",
        status: "failed",
        summary: typeof item.message === "string" ? item.message : "Codex item error."
      };
    case "web_search":
      return {
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        source: "codex",
        toolName: "web_search",
        input: item.query ? { query: item.query } : undefined,
        status,
        summary: item.query ?? "Codex web search."
      };
    default:
      return {
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        source: "codex",
        toolName: item.type ?? "codex_item",
        status,
        summary: item.text ?? item.command ?? item.type ?? "Codex item."
      };
  }
}

function fileChangeOperation(kind: unknown): string {
  if (kind === "add") return "create";
  if (kind === "delete") return "delete";
  return "edit";
}

function mcpToolName(item: CodexItem): string {
  if (typeof item.tool_name === "string") return item.tool_name;
  if (typeof item.name === "string") return item.name;
  if (typeof item.server === "string" && typeof item.tool === "string") return `mcp__${item.server}__${item.tool}`;
  if (typeof item.tool === "string") return item.tool;
  return "mcp";
}

function markLastAssistantMessageAsFinal(events: RawEvent[]): void {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "message" && event.role === "assistant") {
      events[index] = {
        ...event,
        type: "final_response"
      };
      return;
    }
  }
}

function normalizeUsage(usage: CodexUsage | undefined): UsageInput | undefined {
  if (!usage) return undefined;

  const inputTokens = positiveInteger(usage.input_tokens);
  const outputTokens = sumTokens(positiveInteger(usage.output_tokens), positiveInteger(usage.reasoning_output_tokens));
  const totalTokens = sumTokens(inputTokens, outputTokens);

  return {
    inputTokens: inputTokens ?? undefined,
    outputTokens: outputTokens ?? undefined,
    totalTokens: totalTokens ?? undefined
  };
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function sumTokens(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((total, value) => total + value, 0) : null;
}

function errorSummary(record: CodexRecord): string {
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object" && typeof record.error.message === "string") return record.error.message;
  return "Codex execution failed.";
}

function stringifyOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
