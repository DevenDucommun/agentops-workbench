import { basename, resolve } from "node:path";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { redactValue } from "./redaction";
import type { ParsedTranscript, RawEvent, SessionRecord, UsageInput } from "./types";

type ClaudeStreamRecord = {
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: ClaudeMessage;
  result?: string;
  errors?: string[];
  is_error?: boolean;
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  stop_reason?: string | null;
  _lineNumber?: number;
  [key: string]: unknown;
};

type ClaudeMessage = {
  role?: string;
  model?: string;
  content?: string | ClaudeContentBlock[];
  usage?: ClaudeUsage;
  [key: string]: unknown;
};

type ClaudeContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
};

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
};

export function parseClaudeCodeStreamJsonl(sourcePath: string, input: string, config: AgentOpsConfig = defaultConfig): ParsedTranscript {
  const records = input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseClaudeLine(line, index + 1));
  validateClaudeRecords(records);

  const sessionId = records.find((record) => typeof record.session_id === "string")?.session_id;
  const fallbackId = basename(sourcePath).replace(/\.[^.]+$/, "") || "claude-code-stream-session";
  const model = records.map((record) => record.message?.model).find((value): value is string => typeof value === "string" && value.trim().length > 0);

  const events = records.flatMap((record) => normalizeRecord(record));
  const session: SessionRecord & { id: string; sourcePath: string; sourceAdapter: string } = {
    type: "session",
    schemaVersion: "agentops.event.v1",
    id: sessionId ?? fallbackId,
    source: "claude-code",
    agent: "Claude Code",
    model,
    task: "Claude Code stream JSON capture",
    sourcePath: resolve(sourcePath),
    sourceAdapter: "claude-code-stream-json"
  };

  if (!config.privacy.redactBeforeStore) {
    return { session, events };
  }

  return {
    session: redactValue(session),
    events: events.map((event) => redactValue(event))
  };
}

function parseClaudeLine(line: string, lineNumber: number): ClaudeStreamRecord {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record must be a JSON object");
    }
    return { ...(value as ClaudeStreamRecord), _lineNumber: lineNumber };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Claude Code stream JSONL record on line ${lineNumber}: ${reason}`);
  }
}

function validateClaudeRecords(records: ClaudeStreamRecord[]): void {
  if (!records.length) throw new Error("Unsupported Claude Code stream JSONL shape: expected JSONL records from `claude -p --output-format stream-json`.");

  const knownTypes = new Set(["system", "assistant", "user", "result", "tool_progress"]);
  const knownRecords = records.filter((record) => typeof record.type === "string" && knownTypes.has(record.type));
  if (!knownRecords.length) {
    throw new Error("Unsupported Claude Code stream JSONL shape: expected system, assistant, user, result, or tool_progress events.");
  }

  for (const record of records) {
    if ((record.type === "assistant" || record.type === "user") && !isRecord(record.message)) {
      throw new Error(`Unsupported Claude Code stream JSONL record on line ${record._lineNumber ?? "unknown"}: ${record.type} event must include a message object.`);
    }
    if (record.type === "result" && record.subtype === undefined) {
      throw new Error(`Unsupported Claude Code stream JSONL record on line ${record._lineNumber ?? "unknown"}: result event must include subtype.`);
    }
  }
}

function normalizeRecord(record: ClaudeStreamRecord): RawEvent[] {
  switch (record.type) {
    case "system":
      return normalizeSystemRecord(record);
    case "assistant":
      return normalizeAssistantRecord(record);
    case "user":
      return normalizeUserRecord(record);
    case "result":
      return [normalizeResultRecord(record)];
    case "tool_progress":
      return [
        {
          schemaVersion: "agentops.event.v1",
          type: "tool_call",
          source: "claude-code",
          status: "in_progress",
          summary: "Claude Code tool progress."
        }
      ];
    default:
      return [
        {
          schemaVersion: "agentops.event.v1",
          type: "message",
          source: "claude-code",
          summary: typeof record.type === "string" ? `Claude Code event: ${record.type}` : "Claude Code event"
        }
      ];
  }
}

function normalizeSystemRecord(record: ClaudeStreamRecord): RawEvent[] {
  return [
    {
      schemaVersion: "agentops.event.v1",
      type: "message",
      source: "claude-code",
      role: "system",
      status: record.subtype,
      summary: record.subtype === "init" ? "Claude Code session initialized." : `Claude Code system event: ${record.subtype ?? "system"}`
    }
  ];
}

function normalizeAssistantRecord(record: ClaudeStreamRecord): RawEvent[] {
  const blocks = contentBlocks(record.message?.content);
  if (blocks.length === 0) {
    return [
      {
        schemaVersion: "agentops.event.v1",
        type: "message",
        source: "claude-code",
        role: "assistant",
        summary: "Claude Code assistant message."
      }
    ];
  }

  return blocks.flatMap((block) => normalizeAssistantBlock(block));
}

function normalizeAssistantBlock(block: ClaudeContentBlock): RawEvent[] {
  if (block.type === "text") {
    return [
      {
        schemaVersion: "agentops.event.v1",
        type: "message",
        source: "claude-code",
        role: "assistant",
        content: block.text,
        summary: block.text ?? "Claude Code assistant message."
      }
    ];
  }

  if (block.type === "tool_use") return [normalizeToolUse(block)];

  return [
    {
      schemaVersion: "agentops.event.v1",
      type: "message",
      source: "claude-code",
      role: "assistant",
      summary: typeof block.type === "string" ? `Claude Code assistant block: ${block.type}` : "Claude Code assistant block"
    }
  ];
}

function normalizeUserRecord(record: ClaudeStreamRecord): RawEvent[] {
  const blocks = contentBlocks(record.message?.content);
  const text = textContent(record.message?.content);
  const toolResults = blocks.filter((block) => block.type === "tool_result");
  const events: RawEvent[] = [];

  if (text) {
    events.push({
      schemaVersion: "agentops.event.v1",
      type: "message",
      source: "claude-code",
      role: "user",
      content: text,
      summary: text
    });
  }

  for (const result of toolResults) {
    events.push({
      schemaVersion: "agentops.event.v1",
      type: "tool_result",
      source: "claude-code",
      status: result.is_error ? "failed" : "completed",
      output: stringifyOutput(result.content),
      summary: result.is_error ? "Claude Code tool result failed." : "Claude Code tool result completed."
    });
  }

  return events;
}

function normalizeResultRecord(record: ClaudeStreamRecord): RawEvent {
  const failed = record.subtype !== "success" || record.is_error === true;
  return {
    schemaVersion: "agentops.event.v1",
    type: failed ? "error" : "final_response",
    source: "claude-code",
    role: "assistant",
    status: record.subtype ?? (failed ? "failed" : "completed"),
    content: failed ? record.errors?.join("\n") : record.result,
    summary: failed ? record.errors?.[0] ?? "Claude Code execution failed." : record.result ?? "Claude Code stream completed.",
    usage: normalizeUsage(record.usage, record.total_cost_usd)
  };
}

function normalizeToolUse(block: ClaudeContentBlock): RawEvent {
  const name = block.name ?? "claude_tool";
  const input = block.input;
  const command = typeof input?.command === "string" ? input.command : undefined;
  const path = pathFromInput(input);

  if (name === "Bash") {
    return {
      schemaVersion: "agentops.event.v1",
      type: "tool_call",
      source: "claude-code",
      toolName: name,
      command,
      input,
      status: "completed",
      summary: command ?? "Claude Code Bash tool use."
    };
  }

  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) {
    return {
      schemaVersion: "agentops.event.v1",
      type: "file_edit",
      source: "claude-code",
      toolName: name,
      path,
      operation: name.toLowerCase(),
      input,
      status: "completed",
      summary: path ?? `Claude Code ${name} tool use.`
    };
  }

  if (["Read", "Glob", "Grep"].includes(name)) {
    return {
      schemaVersion: "agentops.event.v1",
      type: "file_read",
      source: "claude-code",
      toolName: name,
      path,
      input,
      status: "completed",
      summary: path ?? `Claude Code ${name} tool use.`
    };
  }

  return {
    schemaVersion: "agentops.event.v1",
    type: "tool_call",
    source: "claude-code",
    toolName: name,
    input,
    status: "completed",
    summary: name
  };
}

function contentBlocks(content: ClaudeMessage["content"] | undefined): ClaudeContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ClaudeContentBlock => Boolean(block) && typeof block === "object" && !Array.isArray(block));
}

function textContent(content: ClaudeMessage["content"] | undefined): string | undefined {
  if (typeof content === "string") return compact(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text ? compact(text) : undefined;
}

function pathFromInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.notebook_path === "string") return input.notebook_path;
  return undefined;
}

function normalizeUsage(usage: ClaudeUsage | undefined, totalCostUsd: unknown): UsageInput | undefined {
  if (!usage && typeof totalCostUsd !== "number") return undefined;

  const inputTokens = positiveInteger(usage?.input_tokens);
  const outputTokens = positiveInteger(usage?.output_tokens);
  const totalTokens = sumTokens(inputTokens, outputTokens);
  const costUsd = typeof totalCostUsd === "number" && Number.isFinite(totalCostUsd) && totalCostUsd >= 0 ? totalCostUsd : undefined;

  return {
    inputTokens: inputTokens ?? undefined,
    outputTokens: outputTokens ?? undefined,
    totalTokens: totalTokens ?? undefined,
    costUsd
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

function stringifyOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function compact(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
