import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentOpsConfig } from "./config";
import { fallbackSessionId } from "./parser";
import { redactValue } from "./redaction";
import { findRepositoryRoots } from "./recorder/enrollment";
import { buildSpoolRecord, RECORDER_ERROR_TYPE, SPOOL_RECORD_TYPE } from "./recorder/spool";
import type { ParsedTranscript, RawEvent, SessionRecord } from "./types";

// `claude-hooks` adapter (forensic recorder spec R1.6): turns a recorder spool
// (src/recorder/spool.ts records) into agentops.event.v1 events. Raw Claude
// Code hook payloads (the T0.2 fixture shape) are accepted too and go through
// the same spool normalization and privacy transform first. One event per
// spool record, so `seq` stays continuous in the store; the chain fields
// (eventId, seq, prevHash, hash) describe the spool record, which is what
// `agentops verify` checks.

const FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const FILE_READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

type Spooled = RawEvent & { payload?: Record<string, unknown> };

export function detectClaudeHooks(content: string): { matched: boolean; confidence: number; reason: string } {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === RECORDER_ERROR_TYPE) continue;
    if (record?.type === SPOOL_RECORD_TYPE && typeof record.hookEventName === "string") {
      return { matched: true, confidence: 1, reason: "found forensic recorder spool record" };
    }
    if (typeof record?.hook_event_name === "string" && typeof record.session_id === "string") {
      return { matched: true, confidence: 0.9, reason: "found raw Claude Code hook payload" };
    }
    return { matched: false, confidence: 0, reason: "no recorder spool or hook payload markers" };
  }
  return { matched: false, confidence: 0, reason: "empty input" };
}

/** Use one root for the entire raw recording, including offline captures from another checkout. */
function rawRecordingRoot(cwds: string[]): string | undefined {
  if (!cwds.length || !cwds.every(isAbsolute)) return;
  const contains = (root: string, path: string) => path === root || path.startsWith(root + sep);
  const localRoot = findRepositoryRoots(process.cwd())?.checkout;
  if (localRoot && cwds.every((path) => contains(localRoot, path))) return localRoot;
  let common = cwds[0];
  for (const cwd of cwds) {
    while (!contains(common, cwd)) {
      const parent = dirname(common);
      if (parent === common) return;
      common = parent;
    }
  }
  // A drive, volume or user home is not a repository boundary.
  if (common === dirname(common) || /^\/(?:Users|home|Volumes)(?:\/[^/]+)?$/.test(common)) return;
  return common;
}

export function parseClaudeHooksJsonl(sourcePath: string, content: string, config: AgentOpsConfig): ParsedTranscript {
  const inputRecords: Spooled[] = [];
  const rawCwds = new Set<string>();
  const lines = content.split(/\r?\n/);
  lines.forEach((line) => {
    if (!line.trim()) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The writer can recover after an interrupted append at any line.
      return;
    }
    if (parsed?.type === RECORDER_ERROR_TYPE) return;
    if (parsed?.type === SPOOL_RECORD_TYPE) {
      inputRecords.push(parsed as Spooled);
    } else if (typeof parsed?.hook_event_name === "string") {
      if (typeof parsed.cwd === "string") rawCwds.add(parsed.cwd);
      inputRecords.push(parsed as Spooled);
    }
  });
  const root = rawRecordingRoot([...rawCwds]);
  const repoRoots = root ? checkoutRoots(root) : [];
  const records = inputRecords.map((record) => record.type === SPOOL_RECORD_TYPE ? record : buildSpoolRecord(record, {
    storeRawPayload: config.privacy.storeRawPayload, repoRoots
  }) as Spooled);
  if (records.length === 0) throw new Error("Unsupported claude-hooks shape: expected forensic recorder spool records or Claude Code hook payloads.");

  // A record capped for size can lose payload.session_id. Without any id, the
  // fallback hashes the content as the other adapters do, so two captures that
  // share a file name stay separate sessions and replaying one stays idempotent.
  const sessionId =
    records.map((r) => r.payload?.session_id).find((v): v is string => typeof v === "string") ??
    fallbackSessionId(sourcePath, content, "claude-hooks-session");
  // Agent tool results name the subagent they ran; events inside it point back at that call.
  const parentByAgent = new Map<string, string>();
  for (const r of records) {
    const agentId = (r.payload?.tool_response as { agentId?: unknown } | undefined)?.agentId;
    if (r.toolName === "Agent" && typeof agentId === "string" && typeof r.toolUseId === "string") parentByAgent.set(agentId, r.toolUseId);
  }

  const events = records.map((r) => normalize(r, parentByAgent));
  const timestamps = records.map((r) => r.timestamp).filter((t): t is string => typeof t === "string");
  const firstPrompt = records.find((r) => r.hookEventName === "UserPromptSubmit")?.payload?.prompt;
  const session: SessionRecord & { id: string; sourcePath: string; sourceAdapter: string } = {
    type: "session",
    schemaVersion: "agentops.event.v1",
    id: sessionId,
    source: "claude-code",
    agent: "Claude Code",
    task: typeof firstPrompt === "string" ? compactText(firstPrompt) : "Claude Code recorded session",
    startedAt: timestamps[0],
    endedAt: [...records].reverse().find((r) => r.hookEventName === "SessionEnd")?.timestamp as string | undefined,
    sourcePath: resolve(sourcePath),
    sourceAdapter: "claude-hooks"
  };
  for (const key of Object.keys(session) as Array<keyof typeof session>) if (session[key] === undefined) delete session[key];

  if (!config.privacy.redactBeforeStore) return { session, events };
  return { session: redactValue(session), events: events.map((e) => redactValue(e)) };
}

function normalize(r: Spooled, parentByAgent: Map<string, string>): RawEvent {
  const p = r.payload ?? {};
  const input = (p.tool_input as Record<string, unknown> | undefined) ?? undefined;
  const response = (p.tool_response as Record<string, unknown> | undefined) ?? undefined;
  const tool = typeof r.toolName === "string" ? r.toolName : undefined;
  const base: RawEvent = {
    schemaVersion: "agentops.event.v1",
    source: "claude-code",
    timestamp: r.timestamp,
    hookEventName: r.hookEventName,
    eventId: r.eventId,
    seq: r.seq,
    prevHash: r.prevHash,
    hash: r.hash,
    cwd: r.cwd,
    toolUseId: r.toolUseId,
    agentId: r.agentId,
    parentToolUseId: typeof r.agentId === "string" ? parentByAgent.get(r.agentId) : undefined,
    contentHash: r.contentHash
  };
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const event = ((): RawEvent => {
    switch (r.hookEventName) {
      case "UserPromptSubmit":
        return { ...base, type: "message", role: "user", content: text(p.prompt), summary: compactText(text(p.prompt) ?? "User prompt") };
      case "Stop":
        return { ...base, type: "final_response", role: "assistant", content: text(p.last_assistant_message), summary: text(p.last_assistant_message) ?? "Turn finished" };
      case "SubagentStop":
        return { ...base, type: "message", role: "assistant", content: text(p.last_assistant_message), summary: `Subagent ${text(r.agentType) ?? ""} finished`.replace(/\s+/g, " ") };
      case "PreToolUse":
        // The matching PostToolUse/PostToolUseFailure carries the result; this marks the start only.
        return { ...base, type: "tool_started", toolName: tool, summary: `Started ${tool ?? "tool"}` };
      case "PostToolUse":
        return toolEvent(base, tool, input, response, r, "completed");
      case "PostToolUseFailure":
        return toolEvent(base, tool, input, response, r, p.is_interrupt === true ? "interrupted" : "failed");
      case "PostToolBatch":
        return { ...base, type: "tool_batch", summary: "Tool batch finished" };
      default:
        return { ...base, type: "message", role: "system", summary: lifecycleSummary(r) };
    }
  })();
  for (const key of Object.keys(event)) if (event[key] === undefined) delete event[key];
  return event;
}

function toolEvent(base: RawEvent, tool: string | undefined, input: Record<string, unknown> | undefined, response: Record<string, unknown> | undefined, r: Spooled, status: string): RawEvent {
  const name = tool ?? "claude_tool";
  const failed = status !== "completed";
  if (name === "Bash") {
    const command = typeof input?.command === "string" ? input.command : undefined;
    const stdout = typeof response?.stdout === "string" ? response.stdout : undefined;
    const commit = (response?.gitOperation as { commit?: Record<string, unknown> } | undefined)?.commit;
    // A background launch (requested, after a timeout, or by the user) only
    // acknowledges the start; its exit code is not this call's, so it is still running.
    // A reported failure (PostToolUseFailure) or interruption keeps its own status.
    const background =
      !failed &&
      response?.interrupted !== true &&
      (input?.run_in_background === true ||
      typeof response?.backgroundTaskId === "string" ||
      response?.backgroundedByUser === true ||
      response?.assistantAutoBackgrounded === true);
    if (background) {
      return { ...base, type: "tool_call", toolName: name, command, input: command === undefined ? undefined : { command }, status: "started", output: stdout, summary: command ?? "Bash" };
    }
    // An exit code the record or the tool response reports wins over the hook's
    // generic success: a PostToolUse can carry exitCode / exit_code 1.
    const reported = [r.exitCode, r.exit_code, response?.exitCode, response?.exit_code].find((value): value is number => typeof value === "number");
    return {
      ...base,
      type: "tool_call",
      toolName: name,
      command,
      input: command === undefined ? undefined : { command },
      // A reported nonzero exit only upgrades the hook's generic success; an
      // explicit interruption or failure keeps its own status.
      status: response?.interrupted === true || status === "interrupted" ? "interrupted" : status === "completed" && reported !== undefined && reported !== 0 ? "failed" : status,
      exitCode: reported ?? (failed ? undefined : 0),
      output: stdout,
      gitCommit: !failed && response?.interrupted !== true ? (r.gitCommit ?? commit) : undefined,
      summary: command ?? "Bash"
    };
  }
  const path = [r.path, input?.file_path, input?.notebook_path, input?.path].find((value): value is string => typeof value === "string");
  if (FILE_EDIT_TOOLS.has(name)) {
    return {
      ...base,
      type: failed ? "tool_call" : response?.type === "create" ? "file_write" : "file_edit",
      toolName: name,
      path,
      operation: response?.type === "create" ? "create" : name.toLowerCase(),
      linesAdded: typeof r.linesAdded === "number" ? r.linesAdded : undefined,
      linesRemoved: typeof r.linesRemoved === "number" ? r.linesRemoved : undefined,
      status,
      summary: path ?? name
    };
  }
  if (FILE_READ_TOOLS.has(name)) {
    return { ...base, type: "file_read", toolName: name, path, status, summary: path ?? name };
  }
  const subagent = name === "Agent" && typeof response?.agentId === "string" ? response.agentId : undefined;
  const description = typeof input?.description === "string" ? input.description : undefined;
  return { ...base, type: "tool_call", toolName: name, status, subagentId: subagent, summary: description ? `${name}: ${description}` : name };
}

function compactText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function lifecycleSummary(r: Spooled): string {
  const p = r.payload ?? {};
  switch (r.hookEventName) {
    case "SessionStart":
      return `Session started (${typeof p.source === "string" ? p.source : "unknown"})`;
    case "SessionEnd":
      return `Session ended (${typeof p.reason === "string" ? p.reason : "unknown"})`;
    case "SubagentStart":
      return `Subagent ${typeof r.agentType === "string" ? r.agentType : ""} started`.replace(/\s+/g, " ").trim();
    default:
      return typeof r.hookEventName === "string" ? r.hookEventName : "Hook event";
  }
}

function checkoutRoots(cwd: string): string[] {
  const checkout = findRepositoryRoots(cwd)?.checkout;
  if (!checkout) return [cwd];
  try {
    return [...new Set([checkout, resolve(cwd, relative(realpathSync(cwd), checkout))])];
  } catch {
    return [checkout];
  }
}
