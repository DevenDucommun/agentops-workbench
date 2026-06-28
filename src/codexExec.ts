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
  exit_code?: number;
  path?: string;
  file_path?: string;
  filePath?: string;
  operation?: string;
  lines_added?: number;
  lines_removed?: number;
  tool_name?: string;
  name?: string;
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

  const knownTypes = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "error", "item.started", "item.completed"]);
  const knownRecords = records.filter((record) => typeof record.type === "string" && knownTypes.has(record.type));
  if (!knownRecords.length) {
    throw new Error("Unsupported Codex exec JSONL shape: expected thread, turn, item, or error events from `codex exec --json`.");
  }

  for (const record of records) {
    if ((record.type === "item.started" || record.type === "item.completed") && !isRecord(record.item)) {
      throw new Error(`Unsupported Codex exec JSONL record on line ${record._lineNumber ?? "unknown"}: ${record.type} must include an item object.`);
    }
    if ((record.type === "item.started" || record.type === "item.completed") && typeof record.item?.type !== "string") {
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
    case "item.started":
    case "item.completed":
      return record.item ? [normalizeItem(record.item, record.type)] : [];
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

function normalizeItem(item: CodexItem, recordType: string): RawEvent {
  const status = item.status ?? (recordType === "item.started" ? "in_progress" : "completed");

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
        output: typeof item.output === "string" ? item.output : undefined,
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
    case "mcp_tool_call":
      return {
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        source: "codex",
        toolName: item.tool_name ?? item.name ?? "mcp",
        input: item.arguments ?? item.args,
        output: stringifyOutput(item.result),
        status,
        summary: item.tool_name ?? item.name ?? "Codex MCP tool call."
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
