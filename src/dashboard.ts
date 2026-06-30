import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimsFinalSuccess, evaluateEvidenceClaims, isVerificationCommand } from "./analyzer";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { generateMarkdownReport } from "./report";
import {
  getCommands,
  getEvents,
  getFileChanges,
  getRiskFlags,
  getSession,
  getToolCalls,
  getUsageSummary,
  listSessions,
  openStore,
  type Store
} from "./store";
import type { CommandRecord, FileChangeRecord, RiskFlagRecord, SessionSummary, StoredEvent, ToolCallRecord, UsageSummary } from "./types";

export type DashboardOptions = {
  host?: string;
  port?: number;
  storePath?: string;
  config?: AgentOpsConfig;
};

export type DashboardServer = {
  url: string;
  stop: () => void;
};

type DashboardSessionDetail = {
  session: DashboardSessionRecord;
  evidenceQuality: DashboardEvidenceQuality;
  usage: UsageSummary;
  events: StoredEvent[];
  commands: CommandRecord[];
  files: FileChangeRecord[];
  tools: ToolCallRecord[];
  risks: RiskFlagRecord[];
  verification: CommandRecord[];
  decision: DashboardDecision;
  riskDrilldown: DashboardRiskDrilldown;
};

type DashboardSessionRecord = Omit<NonNullable<ReturnType<typeof getSession>>, "source_path">;

type DashboardSessionSummary = Omit<SessionSummary, "sourcePath">;

type DashboardEvidenceBundle = {
  schemaVersion: "agentops.evidence.v1";
  kind: "session-evidence";
  session: DashboardSessionRecord;
  evidenceQuality: DashboardEvidenceQuality;
  usage: UsageSummary;
  decision: DashboardDecision;
  riskDrilldown: DashboardRiskDrilldown;
  verification: DashboardPublicCommand[];
  commands: DashboardPublicCommand[];
  files: FileChangeRecord[];
  risks: RiskFlagRecord[];
  events: DashboardPublicEvent[];
};

type DashboardComparison = {
  schemaVersion: "agentops.comparison.v1";
  kind: "session-comparison";
  compatible: {
    sameRepo: boolean;
    message: string | null;
  };
  base: DashboardComparisonSession;
  target: DashboardComparisonSession;
  deltas: DashboardComparisonDeltas;
  risks: DashboardComparisonRisk[];
  files: DashboardComparisonSetDiff;
  commands: DashboardComparisonSetDiff;
  verification: DashboardComparisonSetDiff;
};

type DashboardComparisonSession = {
  id: string;
  task: string | null;
  repo: string | null;
  readiness: DashboardMergeReadiness["status"];
  riskCount: number;
  highRiskCount: number;
  mediumRiskCount: number;
  verificationCount: number;
  fileCount: number;
  commandCount: number;
  totalTokens: number | null;
};

type DashboardComparisonDeltas = {
  riskCount: number;
  highRiskCount: number;
  mediumRiskCount: number;
  verificationCount: number;
  fileCount: number;
  commandCount: number;
  totalTokens: number | null;
};

type DashboardComparisonRisk = {
  severity: RiskFlagRecord["severity"];
  category: string;
  baseCount: number;
  targetCount: number;
  delta: number;
};

type DashboardComparisonSetDiff = {
  baseOnly: string[];
  targetOnly: string[];
  common: string[];
};

type DashboardDecision = {
  mergeReadiness: DashboardMergeReadiness;
  evidence: DashboardEvidenceRow[];
};

type DashboardEvidenceQuality = {
  level: "structured" | "forensic" | "weak-forensic";
  label: string;
  sourceAdapter: string | null;
  observedCommandCount: number;
  inferredCommandCount: number;
  inferredFileCount: number;
  notes: string[];
};

type DashboardMergeReadiness = {
  status: "ready" | "needs-review" | "blocked";
  label: string;
  reasons: string[];
  highRiskCount: number;
  mediumRiskCount: number;
  missingEvidenceCount: number;
  verificationCount: number;
};

type DashboardEvidenceRow = {
  id: "test" | "lint" | "typecheck" | "build" | "final-success";
  label: string;
  claimed: boolean;
  evidenceFound: boolean;
  status: "verified" | "inferred-evidence" | "missing-evidence" | "not-claimed";
  command: string | null;
  commandStatus: string | null;
  commandExitCode: number | null;
  riskCategory: string | null;
  riskMessage: string | null;
};

type DashboardRiskDrilldown = {
  totals: {
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  groups: DashboardRiskGroup[];
};

type DashboardRiskGroup = {
  severity: RiskFlagRecord["severity"];
  category: string;
  count: number;
  risks: DashboardRiskItem[];
};

type DashboardRiskItem = {
  id: number;
  severity: RiskFlagRecord["severity"];
  category: string;
  message: string;
  event: DashboardRiskEvent | null;
  command: DashboardRiskCommand | null;
  file: DashboardRiskFile | null;
  evidence: DashboardRiskEvidence | null;
};

type DashboardRiskEvent = Pick<StoredEvent, "id" | "idx" | "type" | "summary">;

type DashboardRiskCommand = Pick<CommandRecord, "id" | "eventId" | "command" | "status" | "exitCode">;

type DashboardRiskFile = Pick<FileChangeRecord, "id" | "eventId" | "path" | "operation" | "linesAdded" | "linesRemoved">;

type DashboardRiskEvidence = Pick<
  DashboardEvidenceRow,
  "id" | "label" | "claimed" | "evidenceFound" | "status" | "command" | "riskCategory" | "riskMessage"
>;

type DashboardPublicCommand = Omit<CommandRecord, "output">;

type DashboardPublicEvent = Omit<StoredEvent, "rawJson" | "rawPayloadHash">;

export function startDashboardServer(options: DashboardOptions = {}): DashboardServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4927;
  const config = options.config ?? defaultConfig;
  const store = openStore(options.storePath);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(request) {
      return handleDashboardRequest(request, store, config);
    }
  });

  return {
    url: server.url.toString().replace(/\/$/, ""),
    stop: () => {
      server.stop(true);
      store.db.close();
    }
  };
}

function handleDashboardRequest(request: Request, store: Store, config: AgentOpsConfig): Response {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return htmlResponse(dashboardHtml());
  }
  if (url.pathname === "/api/health") {
    return jsonResponse({ ok: true, localOnly: true, database: store.path });
  }
  if (url.pathname === "/api/sessions") {
    const limit = positiveLimit(url.searchParams.get("limit"));
    return jsonResponse({ sessions: listSessions(store, limit).map(toDashboardSessionSummary) });
  }
  if (url.pathname === "/api/compare") {
    const baseId = url.searchParams.get("base");
    const targetId = url.searchParams.get("target");
    if (!baseId || !targetId) return jsonResponse({ error: "Missing base or target session" }, 400);
    if (baseId === targetId) return jsonResponse({ error: "Choose two different sessions" }, 400);
    const comparison = getDashboardComparison(store, baseId, targetId, config);
    if (!comparison) return jsonResponse({ error: "Session not found" }, 404);
    return jsonResponse(comparison);
  }
  if (url.pathname.startsWith("/api/sessions/")) {
    const sessionPath = url.pathname.replace("/api/sessions/", "");
    const isReport = sessionPath.endsWith("/report");
    const isEvidence = sessionPath.endsWith("/evidence");
    const sessionId = decodeURIComponent(isReport ? sessionPath.slice(0, -"/report".length) : isEvidence ? sessionPath.slice(0, -"/evidence".length) : sessionPath);
    if (isReport) {
      const session = getSession(store, sessionId);
      if (!session) return jsonResponse({ error: "Session not found" }, 404);
      return markdownResponse(generateMarkdownReport(store, sessionId, config));
    }
    if (isEvidence) {
      const detail = getDashboardSession(store, sessionId, config);
      if (!detail) return jsonResponse({ error: "Session not found" }, 404);
      return evidenceResponse(toEvidenceBundle(detail));
    }
    const detail = getDashboardSession(store, sessionId, config);
    if (!detail) return jsonResponse({ error: "Session not found" }, 404);
    return jsonResponse(detail);
  }
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function getDashboardComparison(store: Store, baseId: string, targetId: string, config: AgentOpsConfig): DashboardComparison | null {
  const base = getDashboardSession(store, baseId, config);
  const target = getDashboardSession(store, targetId, config);
  if (!base || !target) return null;

  return {
    schemaVersion: "agentops.comparison.v1",
    kind: "session-comparison",
    compatible: comparisonCompatibility(base.session.repo, target.session.repo),
    base: toComparisonSession(base),
    target: toComparisonSession(target),
    deltas: {
      riskCount: target.risks.length - base.risks.length,
      highRiskCount: target.riskDrilldown.totals.high - base.riskDrilldown.totals.high,
      mediumRiskCount: target.riskDrilldown.totals.medium - base.riskDrilldown.totals.medium,
      verificationCount: target.verification.length - base.verification.length,
      fileCount: target.files.length - base.files.length,
      commandCount: target.commands.length - base.commands.length,
      totalTokens: nullableDelta(base.usage.totalTokens, target.usage.totalTokens)
    },
    risks: compareRisks(base.risks, target.risks),
    files: compareSets(
      base.files.map((file) => file.path),
      target.files.map((file) => file.path)
    ),
    commands: compareSets(
      base.commands.map((command) => command.command),
      target.commands.map((command) => command.command)
    ),
    verification: compareSets(
      base.verification.map((command) => command.command),
      target.verification.map((command) => command.command)
    )
  };
}

function comparisonCompatibility(baseRepo: string | null, targetRepo: string | null): DashboardComparison["compatible"] {
  if (!baseRepo || !targetRepo) return { sameRepo: true, message: null };
  if (baseRepo === targetRepo) return { sameRepo: true, message: null };
  return {
    sameRepo: false,
    message: `Sessions are from different repos: ${baseRepo} and ${targetRepo}.`
  };
}

function toComparisonSession(detail: DashboardSessionDetail): DashboardComparisonSession {
  return {
    id: detail.session.id,
    task: detail.session.task,
    repo: detail.session.repo,
    readiness: detail.decision.mergeReadiness.status,
    riskCount: detail.risks.length,
    highRiskCount: detail.riskDrilldown.totals.high,
    mediumRiskCount: detail.riskDrilldown.totals.medium,
    verificationCount: detail.verification.length,
    fileCount: detail.files.length,
    commandCount: detail.commands.length,
    totalTokens: detail.usage.totalTokens
  };
}

function compareRisks(base: RiskFlagRecord[], target: RiskFlagRecord[]): DashboardComparisonRisk[] {
  const counts = new Map<string, { severity: RiskFlagRecord["severity"]; category: string; baseCount: number; targetCount: number }>();
  for (const risk of base) {
    const key = `${risk.severity}/${risk.category}`;
    const row = counts.get(key) ?? { severity: risk.severity, category: risk.category, baseCount: 0, targetCount: 0 };
    row.baseCount += 1;
    counts.set(key, row);
  }
  for (const risk of target) {
    const key = `${risk.severity}/${risk.category}`;
    const row = counts.get(key) ?? { severity: risk.severity, category: risk.category, baseCount: 0, targetCount: 0 };
    row.targetCount += 1;
    counts.set(key, row);
  }
  return Array.from(counts.values())
    .map((row) => ({ ...row, delta: row.targetCount - row.baseCount }))
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.category.localeCompare(right.category));
}

function compareSets(baseValues: string[], targetValues: string[]): DashboardComparisonSetDiff {
  const base = uniqueSorted(baseValues);
  const target = uniqueSorted(targetValues);
  const baseSet = new Set(base);
  const targetSet = new Set(target);
  return {
    baseOnly: base.filter((value) => !targetSet.has(value)),
    targetOnly: target.filter((value) => !baseSet.has(value)),
    common: base.filter((value) => targetSet.has(value))
  };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function nullableDelta(base: number | null, target: number | null): number | null {
  return base === null || target === null ? null : target - base;
}

function severityRank(severity: RiskFlagRecord["severity"]): number {
  if (severity === "high") return 0;
  if (severity === "medium") return 1;
  return 2;
}

function getDashboardSession(store: Store, sessionId: string, config: AgentOpsConfig): DashboardSessionDetail | null {
  const session = getSession(store, sessionId);
  if (!session) return null;

  const commands = getCommands(store, sessionId);
  const events = getEvents(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const verification = commands.filter((command) => isVerificationCommand(command.command, config));
  const decision = buildDashboardDecision(events, commands, risks, verification);
  return {
    session: toDashboardSessionRecord(session),
    evidenceQuality: buildEvidenceQuality(session.source_adapter, commands, files, risks),
    usage: getUsageSummary(store, sessionId),
    events,
    commands,
    files,
    tools: getToolCalls(store, sessionId),
    risks,
    verification,
    decision,
    riskDrilldown: buildRiskDrilldown(events, commands, files, risks, decision.evidence)
  };
}

function buildEvidenceQuality(
  sourceAdapter: string | null,
  commands: CommandRecord[],
  files: FileChangeRecord[],
  risks: RiskFlagRecord[]
): DashboardEvidenceQuality {
  if (sourceAdapter !== "forensic-text") {
    return {
      level: "structured",
      label: "Structured JSONL",
      sourceAdapter,
      observedCommandCount: commands.length,
      inferredCommandCount: 0,
      inferredFileCount: 0,
      notes: ["Machine-readable artifact with structured event evidence."]
    };
  }

  const observedCommandCount = commands.filter((command) => command.status === "observed").length;
  const inferredCommandCount = commands.filter((command) => command.status === "inferred").length;
  const inferredFileCount = files.filter((file) => file.operation.startsWith("inferred")).length;
  const weak = risks.some((risk) => risk.category === "weak-forensic-transcript");

  return {
    level: weak ? "weak-forensic" : "forensic",
    label: weak ? "Weak forensic text" : "Forensic text",
    sourceAdapter,
    observedCommandCount,
    inferredCommandCount,
    inferredFileCount,
    notes: weak
      ? ["No observable shell commands were found; verification evidence is missing."]
      : ["Shell-prompt commands are observed; prose-derived command and file mentions are inferred."]
  };
}

function buildRiskDrilldown(
  events: StoredEvent[],
  commands: CommandRecord[],
  files: FileChangeRecord[],
  risks: RiskFlagRecord[],
  evidenceRows: DashboardEvidenceRow[]
): DashboardRiskDrilldown {
  const groups = new Map<string, DashboardRiskGroup>();
  const totals = {
    high: risks.filter((risk) => risk.severity === "high").length,
    medium: risks.filter((risk) => risk.severity === "medium").length,
    low: risks.filter((risk) => risk.severity === "low").length,
    total: risks.length
  };

  for (const risk of risks) {
    const key = `${risk.severity}/${risk.category}`;
    const group =
      groups.get(key) ??
      ({
        severity: risk.severity,
        category: risk.category,
        count: 0,
        risks: []
      } satisfies DashboardRiskGroup);
    group.count += 1;
    group.risks.push(buildRiskItem(risk, events, commands, files, evidenceRows));
    groups.set(key, group);
  }

  return {
    totals,
    groups: Array.from(groups.values())
  };
}

function buildRiskItem(
  risk: RiskFlagRecord,
  events: StoredEvent[],
  commands: CommandRecord[],
  files: FileChangeRecord[],
  evidenceRows: DashboardEvidenceRow[]
): DashboardRiskItem {
  const event = risk.eventId === null ? null : events.find((entry) => entry.id === risk.eventId) ?? null;
  const command = risk.eventId === null ? null : commands.find((entry) => entry.eventId === risk.eventId) ?? null;
  const file = risk.eventId === null ? null : files.find((entry) => entry.eventId === risk.eventId) ?? null;
  const evidence = evidenceRows.find((entry) => entry.riskCategory === risk.category) ?? null;

  return {
    id: risk.id,
    severity: risk.severity,
    category: risk.category,
    message: risk.message,
    event: event ? { id: event.id, idx: event.idx, type: event.type, summary: event.summary } : null,
    command: command
      ? {
          id: command.id,
          eventId: command.eventId,
          command: command.command,
          status: command.status,
          exitCode: command.exitCode
        }
      : null,
    file: file
      ? {
          id: file.id,
          eventId: file.eventId,
          path: file.path,
          operation: file.operation,
          linesAdded: file.linesAdded,
          linesRemoved: file.linesRemoved
        }
      : null,
    evidence: evidence
      ? {
          id: evidence.id,
          label: evidence.label,
          claimed: evidence.claimed,
          evidenceFound: evidence.evidenceFound,
          status: evidence.status,
          command: evidence.command,
          riskCategory: evidence.riskCategory,
          riskMessage: evidence.riskMessage
        }
      : null
  };
}

function buildDashboardDecision(
  events: StoredEvent[],
  commands: CommandRecord[],
  risks: RiskFlagRecord[],
  verification: CommandRecord[]
): DashboardDecision {
  const finalSummary = [...events].reverse().find((event) => event.type === "final_response")?.summary ?? "";
  const evidence = buildEvidenceRows(finalSummary, commands, risks, verification);
  const highRiskCount = risks.filter((risk) => risk.severity === "high").length;
  const mediumRiskCount = risks.filter((risk) => risk.severity === "medium").length;
  const missingEvidenceCount = evidence.filter((row) => row.status === "missing-evidence").length;
  const inferredEvidenceCount = evidence.filter((row) => row.status === "inferred-evidence").length;
  const reasons: string[] = [];
  let status: DashboardMergeReadiness["status"] = "ready";

  if (highRiskCount > 0) {
    status = "blocked";
    reasons.push(`${highRiskCount} high-severity risk${highRiskCount === 1 ? "" : "s"} detected.`);
  }
  if (mediumRiskCount > 0) {
    if (status === "ready") status = "needs-review";
    reasons.push(`${mediumRiskCount} medium-severity risk${mediumRiskCount === 1 ? "" : "s"} detected.`);
  }
  if (missingEvidenceCount > 0) {
    if (status === "ready") status = "needs-review";
    reasons.push(`${missingEvidenceCount} claimed check${missingEvidenceCount === 1 ? "" : "s"} missing command evidence.`);
  }
  if (inferredEvidenceCount > 0) {
    if (status === "ready") status = "needs-review";
    reasons.push(`${inferredEvidenceCount} claimed check${inferredEvidenceCount === 1 ? " has" : "s have"} inferred command evidence.`);
  }
  if (verification.length === 0) {
    if (status === "ready") status = "needs-review";
    reasons.push("No verification command was recorded.");
  }
  if (!reasons.length) reasons.push("No blocking risks or missing evidence detected.");

  return {
    mergeReadiness: {
      status,
      label: status === "ready" ? "Ready" : status === "blocked" ? "Blocked" : "Needs review",
      reasons,
      highRiskCount,
      mediumRiskCount,
      missingEvidenceCount,
      verificationCount: verification.length
    },
    evidence
  };
}

function buildEvidenceRows(
  finalSummary: string,
  commands: CommandRecord[],
  risks: RiskFlagRecord[],
  verification: CommandRecord[]
): DashboardEvidenceRow[] {
  const commandStrings = commands.map((command) => command.command);
  const rows = evaluateEvidenceClaims(finalSummary, commandStrings).map((claim) => {
    const matchingCommand = claim.matchingCommand ? commands.find((command) => command.command === claim.matchingCommand) ?? null : null;
    const risk = risks.find((entry) => entry.category === claim.category) ?? null;
    return toEvidenceRow({
      id: claim.id,
      label: titleCase(claim.label),
      claimed: claim.claimed || risk !== null,
      evidenceFound: claim.supported,
      command: matchingCommand,
      risk
    });
  });
  const successRisk = risks.find((risk) => risk.category === "unsupported-success-claim") ?? null;
  const finalSuccessClaimed = claimsFinalSuccess(finalSummary) || successRisk !== null;
  rows.push(
    toEvidenceRow({
      id: "final-success",
      label: "Final success",
      claimed: finalSuccessClaimed,
      evidenceFound: verification.length > 0,
      command: verification[0] ?? null,
      risk: successRisk
    })
  );
  return rows;
}

function toEvidenceRow(input: {
  id: DashboardEvidenceRow["id"];
  label: string;
  claimed: boolean;
  evidenceFound: boolean;
  command: CommandRecord | null;
  risk: RiskFlagRecord | null;
}): DashboardEvidenceRow {
  const status = evidenceStatus(input.evidenceFound, input.claimed, input.command);
  return {
    id: input.id,
    label: input.label,
    claimed: input.claimed,
    evidenceFound: input.evidenceFound,
    status,
    command: input.command?.command ?? null,
    commandStatus: input.command?.status ?? null,
    commandExitCode: input.command?.exitCode ?? null,
    riskCategory: input.risk?.category ?? null,
    riskMessage: input.risk?.message ?? null
  };
}

function evidenceStatus(
  evidenceFound: boolean,
  claimed: boolean,
  command: CommandRecord | null
): DashboardEvidenceRow["status"] {
  if (!evidenceFound) return claimed ? "missing-evidence" : "not-claimed";
  return command?.status === "inferred" ? "inferred-evidence" : "verified";
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function toDashboardSessionSummary(session: SessionSummary): DashboardSessionSummary {
  const { sourcePath: _sourcePath, ...rest } = session;
  return rest;
}

function toDashboardSessionRecord(session: NonNullable<ReturnType<typeof getSession>>): DashboardSessionRecord {
  const { source_path: _sourcePath, ...rest } = session;
  return rest;
}

function toEvidenceBundle(detail: DashboardSessionDetail): DashboardEvidenceBundle {
  return {
    schemaVersion: "agentops.evidence.v1",
    kind: "session-evidence",
    session: detail.session,
    evidenceQuality: detail.evidenceQuality,
    usage: detail.usage,
    decision: detail.decision,
    riskDrilldown: detail.riskDrilldown,
    verification: detail.verification.map(toPublicCommand),
    commands: detail.commands.map(toPublicCommand),
    files: detail.files,
    risks: detail.risks,
    events: detail.events.map(({ rawJson: _rawJson, rawPayloadHash: _rawPayloadHash, ...event }) => event)
  };
}

function toPublicCommand(command: CommandRecord): DashboardPublicCommand {
  const { output: _output, ...rest } = command;
  return rest;
}

function positiveLimit(value: string | null): number {
  const parsed = Number(value ?? "50");
  if (!Number.isInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 200);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function htmlResponse(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function markdownResponse(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function evidenceResponse(value: DashboardEvidenceBundle): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${safeFilename(value.session.id)}-evidence.json"`
    }
  });
}

function safeFilename(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "session";
}

let cachedDashboardHtml: string | null = null;

function dashboardHtml(): string {
  if (cachedDashboardHtml === null) {
    const dir = import.meta.dir;
    const shell = readFileSync(join(dir, "dashboard.html"), "utf8");
    const css = readFileSync(join(dir, "dashboard.css"), "utf8");
    const js = readFileSync(join(dir, "dashboard.client.js"), "utf8");
    // Function replacers avoid `$`-pattern interpretation in CSS/JS content.
    cachedDashboardHtml = shell.replace("/*__DASHBOARD_CSS__*/", () => css).replace("//__DASHBOARD_JS__", () => js);
  }
  return cachedDashboardHtml;
}
