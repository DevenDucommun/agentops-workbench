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
  usage?: UsageInput;
};

export type UsageInput = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costAmount?: number;
  costCurrency?: string;
  costUsd?: number;
  totalCost?: number;
  cost?: number | { amount?: number; currency?: string };
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
  usage?: UsageInput;
  // Optional chain and provenance fields (forensic recorder, spec R1.5).
  // `eventId` is a stable string ID, unrelated to SQLite row ids.
  eventId?: string;
  seq?: number;
  prevHash?: string | null;
  hash?: string;
  cwd?: string;
  gitHead?: string;
  toolUseId?: string;
  parentToolUseId?: string;
  agentId?: string;
  contentHash?: string;
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
  /** Full final-response text for claim checks (null for other events and older stores). */
  text?: string | null;
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
  totalTokens: number | null;
};

export type UsageSummary = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costAmount: number | null;
  costCurrency: string | null;
};

export type CommandRecord = {
  id: number;
  eventId: number | null;
  command: string;
  status: string | null;
  exitCode: number | null;
  output: string | null;
  /**
   * Evidence tier (evidence trust model, rule 1): `observed` for a structured
   * source's own recorded outcome, `inferred` for anything derived from text.
   * Absent is read as `observed`; stored rows always carry a value.
   */
  evidenceTier?: EvidenceTier;
};

export type EvidenceTier = "observed" | "inferred";

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

export type ToolCallRecord = {
  id: number;
  eventId: number | null;
  toolName: string;
  category: "shell" | "file" | "mcp" | "web" | "other";
  status: string | null;
  count: number;
};
