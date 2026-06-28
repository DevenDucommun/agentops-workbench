import { basename, resolve } from "node:path";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { redactValue } from "./redaction";
import type { ParsedTranscript, RawEvent, SessionRecord } from "./types";

export type ParseOptions = {
  sourceAdapter?: string;
  config?: AgentOpsConfig;
};

export function parseJsonlTranscript(sourcePath: string, input: string, options: ParseOptions = {}): ParsedTranscript {
  const config = options.config ?? defaultConfig;
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const records = lines.map((line, index) => parseLine(line, index + 1));
  const sessionRecord = records.find((record): record is SessionRecord => record.type === "session");
  const events = records.filter((record) => record.type !== "session") as RawEvent[];
  const normalizedSession = config.privacy.redactBeforeStore && sessionRecord ? redactValue(sessionRecord) : sessionRecord;
  const normalizedEvents = config.privacy.redactBeforeStore ? events.map((event) => redactValue(event)) : events;

  const resolvedPath = resolve(sourcePath);
  const fallbackId = basename(sourcePath).replace(/\.[^.]+$/, "") || "session";

  return {
    session: {
      type: "session",
      schemaVersion: normalizedSession?.schemaVersion ?? "agentops.event.v1",
      id: normalizedSession?.id ?? fallbackId,
      agent: normalizedSession?.agent,
      model: normalizedSession?.model,
      repo: normalizedSession?.repo,
      task: normalizedSession?.task,
      source: normalizedSession?.source,
      startedAt: normalizedSession?.startedAt,
      endedAt: normalizedSession?.endedAt,
      sourcePath: resolvedPath,
      sourceAdapter: options.sourceAdapter ?? "agentops-jsonl"
    },
    events: normalizedEvents
  };
}

function parseLine(line: string, lineNumber: number): RawEvent | SessionRecord {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("record must be a JSON object");
    }
    return value as RawEvent | SessionRecord;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSONL record on line ${lineNumber}: ${reason}`);
  }
}

export function summarizeEvent(event: RawEvent): string {
  if (typeof event.summary === "string" && event.summary.trim()) return event.summary.trim();
  if (typeof event.content === "string" && event.content.trim()) return compact(event.content);
  if (typeof event.toolName === "string") return event.toolName;
  const command = extractCommand(event);
  if (command) return command;
  const path = extractPath(event);
  if (path) return path;
  return event.type ?? "event";
}

export function extractCommand(event: RawEvent): string | null {
  if (typeof event.command === "string") return event.command;
  if (typeof event.input?.cmd === "string") return event.input.cmd;
  if (typeof event.input?.command === "string") return event.input.command;
  return null;
}

export function extractPath(event: RawEvent): string | null {
  if (typeof event.path === "string") return event.path;
  if (typeof event.input?.path === "string") return event.input.path;
  if (typeof event.input?.file === "string") return event.input.file;
  return null;
}

function compact(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}
