import { isVerificationCommand } from "./analyzer";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import type { GitChange } from "./git";
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
