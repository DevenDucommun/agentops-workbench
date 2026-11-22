import { resolve } from "node:path";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { fallbackSessionId } from "./parser";
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
  terminal_reason?: string;
  permission_denials?: unknown;
  model?: string;
  error?: unknown;
  is_api_error_message?: boolean;
  hook_name?: string;
  hook_event?: string;
  outcome?: string;
  exit_code?: number;
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
  const fallbackId = fallbackSessionId(sourcePath, input, "claude-code-stream-session");
  const model = sessionModel(records);

  // permission_denials (on the final result) name the tool_use ids that never ran.
  const denied = deniedToolUses(records);
  const results = toolResults(records);
  const events = records.flatMap((record) => normalizeRecord(record, denied, results));
  events.push(...unmatchedDenialEvents(denied));
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

function normalizeRecord(record: ClaudeStreamRecord, denied: DeniedToolUses, results: ToolResults): RawEvent[] {
  switch (record.type) {
    case "system":
      return normalizeSystemRecord(record);
    case "assistant":
      return normalizeAssistantRecord(record, denied, results);
    case "user":
      return normalizeUserRecord(record);
    case "result":
      return normalizeResultRecord(record);
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
  // Claude Code 2.x emits a hook_started/hook_response pair for every hook run.
  // The response carries the outcome, so the start record adds nothing.
  if (record.subtype === "hook_started") return [];
  if (record.subtype === "hook_response") {
    const name = record.hook_name ?? record.hook_event ?? "hook";
    const outcome = typeof record.outcome === "string" ? record.outcome : "completed";
    const exit = typeof record.exit_code === "number" ? ` (exit ${record.exit_code})` : "";
    return [
      {
        schemaVersion: "agentops.event.v1",
        type: "message",
        source: "claude-code",
        role: "system",
        status: outcome,
        summary: `Claude Code hook ${name}: ${outcome}${exit}`
      }
    ];
  }
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

function normalizeAssistantRecord(record: ClaudeStreamRecord, denied: DeniedToolUses, results: ToolResults): RawEvent[] {
  if (record.is_api_error_message === true || typeof record.error === "string") {
    const text = textContent(record.message?.content);
    const reason = typeof record.error === "string" ? record.error : "api_error";
    return [
      {
        schemaVersion: "agentops.event.v1",
        type: "error",
        source: "claude-code",
        role: "assistant",
        status: reason,
        content: text,
        summary: text ? `Claude Code API error (${reason}): ${text}` : `Claude Code API error (${reason}).`
      }
    ];
  }

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

  return blocks.flatMap((block) => normalizeAssistantBlock(block, denied, results));
}

function normalizeAssistantBlock(block: ClaudeContentBlock, denied: DeniedToolUses, results: ToolResults): RawEvent[] {
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

  if (block.type === "tool_use") {
    if (typeof block.id === "string" && denied.has(block.id)) {
      denied.get(block.id)!.matched = true;
      return [deniedToolUseEvent(block.name, block.input)];
    }
    return [normalizeToolUse(block, results)];
  }

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
      toolUseId: typeof result.tool_use_id === "string" ? result.tool_use_id : undefined,
      status: result.is_error ? "failed" : "completed",
      output: stringifyOutput(result.content),
      summary: result.is_error ? "Claude Code tool result failed." : "Claude Code tool result completed."
    });
  }

  return events;
}

function normalizeResultRecord(record: ClaudeStreamRecord): RawEvent[] {
  const failed = record.subtype !== "success" || record.is_error === true;
  const errors = Array.isArray(record.errors) ? record.errors.filter((value): value is string => typeof value === "string") : [];
  // Claude Code 2.x can report subtype "success" with is_error=true; terminal_reason says why the run ended.
  const reason = typeof record.terminal_reason === "string" ? record.terminal_reason : undefined;
  const failureText = errors.length ? errors.join("\n") : record.result;
  const failureSummary = errors[0] ?? record.result;
  const result: RawEvent = {
    schemaVersion: "agentops.event.v1",
    type: failed ? "error" : "final_response",
    source: "claude-code",
    role: "assistant",
    status: failed && record.subtype === "success" ? (reason ?? "failed") : (record.subtype ?? (failed ? "failed" : "completed")),
    content: failed ? failureText : record.result,
    summary: failed
      ? `Claude Code execution failed${reason ? ` (${reason})` : ""}${failureSummary ? `: ${failureSummary}` : "."}`
      : record.result ?? "Claude Code stream completed.",
    usage: normalizeUsage(record.usage, record.total_cost_usd)
  };
  return [result];
}

type DeniedToolUses = Map<string, { toolName?: string; input?: Record<string, unknown>; matched: boolean }>;

function deniedToolUses(records: ClaudeStreamRecord[]): DeniedToolUses {
  const denied: DeniedToolUses = new Map();
  for (const record of records) {
    if (record.type !== "result" || !Array.isArray(record.permission_denials)) continue;
    for (const [index, denial] of record.permission_denials.filter(isRecord).entries()) {
      const id = typeof denial.tool_use_id === "string" ? denial.tool_use_id : `unmatched-denial-${index}`;
      denied.set(id, {
        toolName: typeof denial.tool_name === "string" ? denial.tool_name : undefined,
        input: isRecord(denial.tool_input) ? denial.tool_input : undefined,
        matched: false
      });
    }
  }
  return denied;
}

// A denied tool use never ran: record it once, as a denied tool call, never as an
// executed command or a file change.
function deniedToolUseEvent(name: string | undefined, input: Record<string, unknown> | undefined): RawEvent {
  const toolName = name ?? "claude_tool";
  const command = typeof input?.command === "string" ? input.command : undefined;
  return {
    schemaVersion: "agentops.event.v1",
    type: "tool_call",
    source: "claude-code",
    toolName,
    command,
    input,
    status: "denied",
    summary: `Permission denied: ${toolName}${command ? ` (${command})` : ""}`
  };
}

function unmatchedDenialEvents(denied: DeniedToolUses): RawEvent[] {
  return [...denied.values()].filter((denial) => !denial.matched).map((denial) => deniedToolUseEvent(denial.toolName, denial.input));
}

function sessionModel(records: ClaudeStreamRecord[]): string | undefined {
  const usable = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value !== "<synthetic>";
  const initModel = records.find((record) => record.type === "system" && record.subtype === "init" && usable(record.model))?.model;
  return initModel ?? records.map((record) => record.message?.model).find(usable);
}

/** tool_use block -> whether its tool_result reported an error. */
/** tool_use block -> its outcome: failed (true), completed (false), or only a background launch acknowledgement. */
type ToolResults = Map<ClaudeContentBlock, boolean | "background" | "interrupted">;

// A tool_use and its outcome arrive on separate records: the tool_result in a
// later user record carries the tool_use_id and is_error. A result belongs to
// the most recent tool_use with that id before it, and a call's outcome is the
// first result that belongs to it; results with no earlier call are ignored, so
// a reused id never shares an outcome. Both events keep the tool_use_id, and
// the claims ledger applies the same rule to decide whether the result was
// recorded before the final response.
/**
 * Whether a tool_result only acknowledges that the command went to the
 * background (launched with run_in_background, moved there after a timeout, or
 * backgrounded by the user). Its real outcome arrives later, outside this call.
 */
function isBackgroundAcknowledgement(record: ClaudeStreamRecord, block: ClaudeContentBlock): boolean {
  // Only Claude Code's own metadata counts: a foreground command can print any text,
  // and a reported failure stays a failure.
  if (block.is_error) return false;
  const meta = record.tool_use_result;
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  return typeof m.backgroundTaskId === "string" || m.backgroundedByUser === true || m.assistantAutoBackgrounded === true;
}

/** Claude Code's own metadata says the command was interrupted: not a pass, even with is_error false. */
function isInterrupted(record: ClaudeStreamRecord, block: ClaudeContentBlock): boolean {
  if (block.is_error) return false;
  const meta = record.tool_use_result;
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>).interrupted === true;
}

function toolResults(records: ClaudeStreamRecord[]): ToolResults {
  const latestCall = new Map<string, ClaudeContentBlock>();
  const results: ToolResults = new Map();
  for (const record of records) {
    for (const block of contentBlocks(record.message?.content)) {
      if (record.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") latestCall.set(block.id, block);
      if (record.type !== "user" || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const call = latestCall.get(block.tool_use_id);
      // Any is_error value other than false or absent (including a malformed
      // one such as the string "true") is a failure, matching the result event.
      if (call && !results.has(call)) results.set(call, isInterrupted(record, block) ? "interrupted" : isBackgroundAcknowledgement(record, block) ? "background" : Boolean(block.is_error));
    }
  }
  return results;
}

// A Bash command's status comes from its tool_result: an error result is a
// failed run, and a tool_use with no recorded result (`no_result`) proves nothing.
function bashStatus(block: ClaudeContentBlock, results: ToolResults): string {
  // A background run's tool_result only acknowledges the launch; its outcome is
  // not in the stream, so it is still running as far as the ledger can tell.
  const failed = results.get(block);
  // A reported failure is a failure even for a background run.
  if (failed === true) return "failed";
  if (block.input?.run_in_background === true) return "started";
  if (failed === undefined) return "no_result";
  if (failed === "background") return "started";
  if (failed === "interrupted") return "interrupted";
  return failed ? "failed" : "completed";
}

function normalizeToolUse(block: ClaudeContentBlock, results: ToolResults): RawEvent {
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
      toolUseId: typeof block.id === "string" ? block.id : undefined,
      command,
      input,
      status: bashStatus(block, results),
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
      toolInput: input,
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
      toolInput: input,
      status: "completed",
      summary: path ?? `Claude Code ${name} tool use.`
    };
  }

  return {
    schemaVersion: "agentops.event.v1",
    type: "tool_call",
    source: "claude-code",
    toolName: name,
    // Only Bash runs shell commands; other tools keep their input under a key
    // that command extraction never reads, so a `command` argument is data.
    toolInput: input,
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
  if (typeof input.file === "string") return input.file;
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
