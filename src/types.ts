export type SessionRecord = {
  type: "session";
  schemaVersion?: "agentops.event.v1" | string;
  id?: string;
  agent?: string;
  model?: string;
  repo?: string;
  task?: string;
  source?: string;
  startedAt?: string;
  endedAt?: string;
};

export type RawEvent = {
  schemaVersion?: "agentops.event.v1" | string;
  type?: string;
  source?: string;
  timestamp?: string;
  role?: string;
  content?: string;
  summary?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  status?: string;
  exitCode?: number;
  path?: string;
  operation?: string;
  linesAdded?: number;
  linesRemoved?: number;
  startedAt?: string;
  endedAt?: string;
  [key: string]: unknown;
};

export type ParsedTranscript = {
  session: Required<Pick<SessionRecord, "type">> &
    Omit<SessionRecord, "type"> & {
      id: string;
      sourcePath: string;
      sourceAdapter: string;
    };
  events: RawEvent[];
};

export type StoredEvent = {
  id: number;
  idx: number;
  type: string;
  role: string | null;
  summary: string;
  rawJson: string;
  rawPayloadHash: string | null;
};

export type SessionSummary = {
  id: string;
  sourcePath: string;
  schemaVersion: string | null;
  sourceAdapter: string | null;
  agent: string | null;
  model: string | null;
  repo: string | null;
  task: string | null;
  startedAt: string | null;
  endedAt: string | null;
  ingestedAt: string;
  eventCount: number;
  commandCount: number;
  fileChangeCount: number;
  riskCount: number;
};

export type CommandRecord = {
  id: number;
  eventId: number | null;
  command: string;
  status: string | null;
  exitCode: number | null;
  output: string | null;
};

export type FileChangeRecord = {
  id: number;
  eventId: number | null;
  path: string;
  operation: string;
  linesAdded: number | null;
  linesRemoved: number | null;
};

export type RiskFlagRecord = {
  id: number;
  eventId: number | null;
  severity: "low" | "medium" | "high";
  category: string;
  message: string;
};
