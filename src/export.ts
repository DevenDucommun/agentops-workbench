import { isVerificationCommand } from "./analyzer";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import type { GitChange } from "./git";
import { sha256 } from "./redaction";
import {
  getCommands,
  getEvents,
  getFileChanges,
  getRiskFlags,
  getSession,
  getToolCalls,
  getUsageSummary,
  type Store
} from "./store";

type ExportOptions = {
  includeRawPayloads?: boolean;
};

export function generateSessionJsonExport(
  store: Store,
  sessionId: string,
  config: AgentOpsConfig = defaultConfig,
  options: ExportOptions = {}
): string {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const commands = getCommands(store, sessionId);
  const events = getEvents(store, sessionId).map((event) => ({
    id: event.id,
    idx: event.idx,
    type: event.type,
    role: event.role,
    summary: event.summary,
    rawPayloadHash: event.rawPayloadHash,
    ...(options.includeRawPayloads ? { rawJson: event.rawJson } : {})
  }));

  const payload = {
    schemaVersion: "agentops.export.v1",
    kind: "session",
    session: {
      id: session.id,
      schemaVersion: session.schema_version,
      sourceAdapter: session.source_adapter,
      agent: session.agent,
      model: session.model,
      repo: session.repo,
      task: session.task,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      ingestedAt: session.ingested_at
    },
    usage: getUsageSummary(store, sessionId),
    events,
    commands,
    files: getFileChanges(store, sessionId),
    tools: getToolCalls(store, sessionId),
    risks: getRiskFlags(store, sessionId),
    verification: commands.filter((command) => isVerificationCommand(command.command, config))
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function generateOpenInferenceJsonExport(
  store: Store,
  sessionId: string,
  config: AgentOpsConfig = defaultConfig
): string {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const traceId = stableId(`trace:${session.id}`, 32);
  const rootSpanId = stableId(`span:${session.id}:root`, 16);
  const commands = getCommands(store, sessionId);
  const events = getEvents(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const usage = getUsageSummary(store, sessionId);

  const rootAttributes: Record<string, string | number | boolean | null> = {
    "openinference.span.kind": "AGENT",
    "agentops.session.id": session.id,
    "agentops.source.adapter": session.source_adapter,
    "agentops.schema.version": session.schema_version,
    "agentops.repo": session.repo,
    "agentops.risk.count": risks.length,
    "agentops.command.count": commands.length,
    "agentops.verification.count": commands.filter((command) => isVerificationCommand(command.command, config)).length,
    "input.value": session.task,
    "llm.model_name": session.model,
    "llm.token_count.prompt": usage.inputTokens,
    "llm.token_count.completion": usage.outputTokens,
    "llm.token_count.total": usage.totalTokens
  };

  const spans = [
    {
      traceId,
      spanId: rootSpanId,
      parentSpanId: null,
      name: `agentops.session ${session.id}`,
      kind: "INTERNAL",
      startTime: session.started_at,
      endTime: session.ended_at,
      attributes: compactAttributes(rootAttributes)
    },
    ...events.map((event) => ({
      traceId,
      spanId: stableId(`span:${session.id}:event:${event.id}`, 16),
      parentSpanId: rootSpanId,
      name: `agentops.event ${event.type}`,
      kind: "INTERNAL",
      startTime: null,
      endTime: null,
      attributes: compactAttributes({
        "openinference.span.kind": event.type === "tool_call" ? "TOOL" : "CHAIN",
        "agentops.event.id": event.id,
        "agentops.event.idx": event.idx,
        "agentops.event.type": event.type,
        "agentops.event.role": event.role,
        "agentops.event.summary": event.summary,
        "agentops.raw_payload.hash": event.rawPayloadHash
      })
    })),
    ...commands.map((command) => ({
      traceId,
      spanId: stableId(`span:${session.id}:command:${command.id}`, 16),
      parentSpanId: rootSpanId,
      name: `agentops.command ${command.command}`,
      kind: "INTERNAL",
      startTime: null,
      endTime: null,
      attributes: compactAttributes({
        "openinference.span.kind": "TOOL",
        "tool.name": "shell",
        "tool.parameters": command.command,
        "agentops.command.id": command.id,
        "agentops.command.status": command.status,
        "agentops.command.exit_code": command.exitCode
      })
    })),
    ...risks.map((risk) => ({
      traceId,
      spanId: stableId(`span:${session.id}:risk:${risk.id}`, 16),
      parentSpanId: rootSpanId,
      name: `agentops.risk ${risk.category}`,
      kind: "INTERNAL",
      startTime: null,
      endTime: null,
      attributes: compactAttributes({
        "openinference.span.kind": "EVALUATOR",
        "agentops.risk.id": risk.id,
        "agentops.risk.severity": risk.severity,
        "agentops.risk.category": risk.category,
        "agentops.risk.message": risk.message
      })
    }))
  ];

  const payload = {
    schemaVersion: "agentops.openinference.v1",
    kind: "openinference",
    conventions: {
      openTelemetry: "GenAI semantic conventions",
      openInference: "OpenInference semantic conventions",
      note: "JSON span bundle for local export; not OTLP protobuf."
    },
    session: {
      id: session.id,
      sourceAdapter: session.source_adapter,
      agent: session.agent,
      model: session.model,
      repo: session.repo,
      task: session.task,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      ingestedAt: session.ingested_at
    },
    spans
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function generateRepoJsonExport(
  store: Store,
  sessionId: string,
  gitChanges: GitChange[],
  config: AgentOpsConfig = defaultConfig,
  options: ExportOptions = {}
): string {
  const sessionExport = JSON.parse(generateSessionJsonExport(store, sessionId, config, options)) as Record<string, unknown>;
  const files = getFileChanges(store, sessionId);
  const agentPaths = new Set(files.map((file) => file.path));
  const gitPaths = new Set(gitChanges.map((change) => change.path));

  const payload = {
    ...sessionExport,
    kind: "repo",
    git: {
      changes: gitChanges,
      observedChanges: gitChanges.filter((change) => agentPaths.has(change.path)),
      unobservedChanges: gitChanges.filter((change) => !agentPaths.has(change.path)),
      agentOnlyFiles: files.filter((file) => !gitPaths.has(file.path))
    }
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function stableId(input: string, length: number): string {
  return sha256(input).slice(0, length);
}

function compactAttributes(input: Record<string, string | number | boolean | null>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string | number | boolean] => entry[1] !== null));
}
