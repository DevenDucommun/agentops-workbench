#!/usr/bin/env bun
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const outputPath = process.env.AGENTOPS_HOOK_CAPTURE_PATH || ".agentops/captures/hook-events.jsonl";
const source = readArg("--source") || "local-agent";

try {
  const input = await readStdin();
  if (!input.trim()) process.exit(0);

  const hookInput = JSON.parse(input);
  if (!hookInput || typeof hookInput !== "object" || Array.isArray(hookInput)) process.exit(0);

  const envelope = {
    schemaVersion: "agentops.hook-envelope.v1",
    sessionId: stringValue(hookInput.session_id) || "unknown-session",
    source,
    capturedAt: new Date().toISOString(),
    event: normalizeHookEvent(hookInput, source)
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  appendFileSync(outputPath, `${JSON.stringify(envelope)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`AgentOps hook capture skipped: ${message}`);
}

function normalizeHookEvent(input, sourceName) {
  const hookEventName = stringValue(input.hook_event_name) || "hook";
  const toolName = stringValue(input.tool_name);
  const summary = toolName ? `${sourceName} ${hookEventName}: ${toolName}` : `${sourceName} hook event: ${hookEventName}`;

  return {
    schemaVersion: "agentops.event.v1",
    type: toolName ? "tool_call" : "message",
    source: sourceName,
    toolName,
    input: boundedInput(input),
    status: statusForHook(input),
    summary
  };
}

function boundedInput(input) {
  return redactAndBound({
    hookEventName: input.hook_event_name,
    permissionMode: input.permission_mode,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    reason: input.reason
  });
}

function statusForHook(input) {
  const name = stringValue(input.hook_event_name);
  if (name?.includes("Failure") || name === "PermissionDenied") return "failed";
  return "completed";
}

function redactAndBound(value) {
  if (typeof value === "string") return redactString(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactAndBound(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) {
      if (key === "transcript_path" || key === "cwd") continue;
      output[key] = redactAndBound(child);
    }
    return output;
  }
  return value;
}

function redactString(value) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_TOKEN]");
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
