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
  status: "verified" | "missing-evidence" | "not-claimed";
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
  return {
    id: input.id,
    label: input.label,
    claimed: input.claimed,
    evidenceFound: input.evidenceFound,
    status: input.evidenceFound ? "verified" : input.claimed ? "missing-evidence" : "not-claimed",
    command: input.command?.command ?? null,
    commandStatus: input.command?.status ?? null,
    commandExitCode: input.command?.exitCode ?? null,
    riskCategory: input.risk?.category ?? null,
    riskMessage: input.risk?.message ?? null
  };
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

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentOps Workbench</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #18212f;
      --muted: #657386;
      --line: #d9e0e8;
      --accent: #246b55;
      --accent-soft: #e2f1ea;
      --risk: #b42318;
      --risk-soft: #fbe9e7;
      --warn: #9a5b12;
      --warn-soft: #fff2d8;
      --ok: #237044;
      --shadow: 0 1px 2px rgba(24, 33, 47, 0.06);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-size: 14px;
      line-height: 1.45;
    }
    button, input { font: inherit; }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(260px, 340px) 1fr;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: #fbfcfd;
      padding: 18px 14px;
      overflow: auto;
      max-height: 100vh;
      position: sticky;
      top: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 18px; font-weight: 700; letter-spacing: 0; }
    h2 { font-size: 16px; font-weight: 700; letter-spacing: 0; }
    h3 { font-size: 13px; font-weight: 700; letter-spacing: 0; color: var(--muted); text-transform: uppercase; }
    .subtle { color: var(--muted); }
    .refresh {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      width: 34px;
      height: 34px;
      cursor: pointer;
      box-shadow: var(--shadow);
    }
    .header-actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
    }
    .action-button {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      padding: 7px 10px;
      box-shadow: var(--shadow);
      text-decoration: none;
      white-space: nowrap;
    }
    .sessions {
      display: grid;
      gap: 8px;
    }
    .filters {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    .filter-control {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      padding: 7px 9px;
      box-shadow: var(--shadow);
    }
    .filter-control::placeholder {
      color: var(--muted);
    }
    .compare-select {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      padding: 6px 9px;
      box-shadow: var(--shadow);
      max-width: 220px;
    }
    .session-button {
      width: 100%;
      min-height: 86px;
      text-align: left;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      box-shadow: var(--shadow);
    }
    .session-button.active {
      border-color: var(--accent);
      outline: 2px solid rgba(36, 107, 85, 0.16);
    }
    .session-title {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 8px;
      margin-bottom: 6px;
      font-weight: 700;
    }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      background: #edf1f5;
      color: #344153;
      font-size: 12px;
      white-space: nowrap;
    }
    .pill.risk { color: var(--risk); background: var(--risk-soft); }
    .pill.ok { color: var(--ok); background: var(--accent-soft); }
    .main {
      padding: 22px;
      min-width: 0;
    }
    .header {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: start;
      gap: 16px;
      margin-bottom: 18px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(116px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .decision-grid {
      display: grid;
      grid-template-columns: minmax(260px, 0.42fr) minmax(0, 0.58fr);
      gap: 14px;
      margin-bottom: 18px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .metric {
      min-height: 78px;
      padding: 12px;
    }
    .metric-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .metric-value {
      font-size: 22px;
      font-weight: 750;
      letter-spacing: 0;
    }
    .readiness-card {
      padding: 14px;
      min-height: 100%;
    }
    .readiness-card.ready { border-color: #9ed7b7; background: #f2faf5; }
    .readiness-card.needs-review { border-color: #efd08c; background: var(--warn-soft); }
    .readiness-card.blocked { border-color: #f0b4ae; background: var(--risk-soft); }
    .readiness-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 12px;
      margin-bottom: 10px;
    }
    .readiness-title {
      font-size: 20px;
      font-weight: 760;
      letter-spacing: 0;
    }
    .reason-list {
      display: grid;
      gap: 6px;
      margin: 0;
      padding-left: 18px;
      color: #344153;
    }
    .evidence-table {
      display: grid;
      gap: 1px;
      background: #edf1f5;
    }
    .evidence-row {
      display: grid;
      grid-template-columns: minmax(120px, 0.7fr) 120px minmax(160px, 1fr);
      gap: 10px;
      align-items: center;
      min-height: 56px;
      padding: 10px 12px;
      background: #fff;
    }
    .evidence-row:first-child {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      min-height: 36px;
      background: #fbfcfd;
    }
    .evidence-detail {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .pill.missing { color: var(--risk); background: var(--risk-soft); }
    .pill.neutral { color: var(--muted); background: #edf1f5; }
    .comparison-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
    }
    .comparison-metric {
      border: 1px solid #edf1f5;
      border-radius: 8px;
      padding: 10px;
      background: #fff;
    }
    .comparison-value {
      font-size: 18px;
      font-weight: 750;
      margin-top: 4px;
    }
    .delta.good { color: var(--ok); }
    .delta.bad { color: var(--risk); }
    .delta.neutral { color: var(--muted); }
    .comparison-lists {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .mini-list {
      border: 1px solid #edf1f5;
      border-radius: 8px;
      padding: 10px;
      background: #fff;
      min-width: 0;
    }
    .mini-list h4 {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    .mini-list ul {
      margin: 0;
      padding-left: 18px;
    }
    .mini-list li {
      margin-bottom: 5px;
      overflow-wrap: anywhere;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(300px, 0.7fr);
      gap: 14px;
      align-items: start;
    }
    .panel {
      overflow: hidden;
    }
    .panel-head {
      min-height: 48px;
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      background: #fbfcfd;
    }
    .panel-body { padding: 12px 14px; }
    .timeline {
      display: grid;
      gap: 10px;
    }
    .event {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 10px;
      border-bottom: 1px solid #edf1f5;
      padding-bottom: 10px;
    }
    .event:last-child { border-bottom: 0; padding-bottom: 0; }
    .event-index {
      height: 30px;
      border-radius: 6px;
      background: #edf1f5;
      color: #344153;
      display: grid;
      place-items: center;
      font-weight: 700;
    }
    .event-type {
      font-weight: 700;
      margin-bottom: 3px;
    }
    .list {
      display: grid;
      gap: 9px;
    }
    .item {
      border: 1px solid #edf1f5;
      border-radius: 8px;
      padding: 10px;
      background: #fff;
      min-width: 0;
    }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
      color: #172033;
    }
    .risk-card.high { border-color: #f0b4ae; background: var(--risk-soft); }
    .risk-card.medium { border-color: #efd08c; background: var(--warn-soft); }
    .risk-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    .risk-group {
      border: 1px solid #edf1f5;
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }
    .risk-group.high { border-color: #f0b4ae; }
    .risk-group.medium { border-color: #efd08c; }
    .risk-group-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 10px;
      background: #fbfcfd;
      border-bottom: 1px solid #edf1f5;
      font-weight: 700;
    }
    .risk-group.high .risk-group-head { background: var(--risk-soft); }
    .risk-group.medium .risk-group-head { background: var(--warn-soft); }
    .risk-item {
      padding: 10px;
      border-bottom: 1px solid #edf1f5;
    }
    .risk-item:last-child { border-bottom: 0; }
    .risk-context {
      display: grid;
      gap: 6px;
      margin-top: 8px;
    }
    .context-line {
      display: grid;
      grid-template-columns: 68px minmax(0, 1fr);
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .context-label {
      color: #526174;
      font-weight: 700;
    }
    .empty {
      color: var(--muted);
      padding: 14px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: #fbfcfd;
    }
    .tabs {
      display: flex;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfd;
    }
    .tab {
      border: 1px solid transparent;
      background: transparent;
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      color: var(--muted);
    }
    .tab.active {
      background: var(--panel);
      color: var(--ink);
      border-color: var(--line);
      box-shadow: var(--shadow);
    }
    .tool-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }
    .tool-category {
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
    }
    .hidden { display: none; }
    @media (max-width: 980px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .decision-grid { grid-template-columns: 1fr; }
      .evidence-row { grid-template-columns: 1fr; }
      .comparison-grid, .comparison-lists { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      .header { grid-template-columns: 1fr; }
      .header-actions { justify-content: start; flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div>
          <h1>AgentOps Workbench</h1>
          <p class="subtle">Local SQLite dashboard</p>
        </div>
        <button class="refresh" id="refresh" title="Refresh sessions">↻</button>
      </div>
      <div class="filters">
        <input class="filter-control" id="session-filter" type="search" placeholder="Filter sessions">
        <select class="filter-control" id="adapter-filter">
          <option value="">All adapters</option>
        </select>
      </div>
      <div class="sessions" id="sessions"></div>
    </aside>
    <main class="main">
      <section class="header">
        <div>
          <h2 id="session-heading">No session selected</h2>
          <p class="subtle" id="session-task">Ingest a session, then refresh this dashboard.</p>
          <div class="meta" id="session-meta"></div>
        </div>
        <div class="header-actions">
          <select class="compare-select hidden" id="compare-select">
            <option value="">Compare with</option>
          </select>
          <a class="action-button hidden" id="report-link" href="#" target="_blank" rel="noreferrer">Markdown report</a>
          <a class="action-button hidden" id="evidence-link" href="#" target="_blank" rel="noreferrer">JSON evidence</a>
        </div>
      </section>
      <section class="metric-grid" id="metrics"></section>
      <section class="decision-grid" id="decision"></section>
      <section class="panel hidden" id="comparison"></section>
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h3>Timeline</h3>
            <span class="subtle" id="timeline-count"></span>
          </div>
          <div class="panel-body"><div class="timeline" id="timeline"></div></div>
        </div>
        <div class="panel">
          <div class="tabs">
            <button class="tab active" data-tab="risks">Risks</button>
            <button class="tab" data-tab="tools">Tools</button>
            <button class="tab" data-tab="commands">Commands</button>
            <button class="tab" data-tab="files">Files</button>
          </div>
          <div class="panel-body" id="tab-risks"></div>
          <div class="panel-body hidden" id="tab-tools"></div>
          <div class="panel-body hidden" id="tab-commands"></div>
          <div class="panel-body hidden" id="tab-files"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const state = { sessions: [], selectedId: null, detail: null, filterText: "", adapterFilter: "", compareId: "" };
    const fmt = new Intl.NumberFormat("en-US");

    document.getElementById("refresh").addEventListener("click", loadSessions);
    document.getElementById("session-filter").addEventListener("input", (event) => {
      state.filterText = event.target.value;
      renderSessions();
    });
    document.getElementById("adapter-filter").addEventListener("change", (event) => {
      state.adapterFilter = event.target.value;
      renderSessions();
    });
    document.getElementById("compare-select").addEventListener("change", async (event) => {
      state.compareId = event.target.value;
      if (state.compareId) await loadComparison();
      else renderComparison(null);
    });
    for (const tab of document.querySelectorAll(".tab")) {
      tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    }

    loadSessions();

    async function loadSessions() {
      const response = await fetch("/api/sessions?limit=50");
      const payload = await response.json();
      state.sessions = payload.sessions || [];
      if (!state.selectedId && state.sessions.length) state.selectedId = state.sessions[0].id;
      renderFilters();
      renderSessions();
      if (state.selectedId) await loadSession(state.selectedId);
      if (!state.sessions.length) renderEmpty();
    }

    async function loadSession(id) {
      state.selectedId = id;
      renderSessions();
      const response = await fetch("/api/sessions/" + encodeURIComponent(id));
      state.detail = await response.json();
      renderDetail();
    }

    function renderSessions() {
      const container = document.getElementById("sessions");
      if (!state.sessions.length) {
        container.innerHTML = '<div class="empty">No sessions found.</div>';
        return;
      }
      const sessions = filteredSessions();
      if (!sessions.length) {
        container.innerHTML = '<div class="empty">No matching sessions.</div>';
        return;
      }
      container.innerHTML = sessions.map((session) => {
        const active = session.id === state.selectedId ? " active" : "";
        return '<button class="session-button' + active + '" data-id="' + escapeAttr(session.id) + '">' +
          '<div class="session-title"><span>' + escapeHtml(session.id) + '</span><span class="pill ' + (session.riskCount ? 'risk' : 'ok') + '">' + session.riskCount + ' risks</span></div>' +
          '<div class="subtle">' + escapeHtml(session.task || "Untitled task") + '</div>' +
          '<div class="pill-row">' +
            '<span class="pill">' + escapeHtml(session.sourceAdapter || "unknown") + '</span>' +
            '<span class="pill">' + session.eventCount + ' events</span>' +
            '<span class="pill">' + session.commandCount + ' commands</span>' +
          '</div>' +
        '</button>';
      }).join("");
      for (const button of container.querySelectorAll(".session-button")) {
        button.addEventListener("click", () => loadSession(button.dataset.id));
      }
    }

    function renderFilters() {
      const select = document.getElementById("adapter-filter");
      const adapters = Array.from(new Set(state.sessions.map((session) => session.sourceAdapter || "unknown"))).sort();
      select.innerHTML = '<option value="">All adapters</option>' + adapters.map((adapter) => '<option value="' + escapeAttr(adapter) + '">' + escapeHtml(adapter) + '</option>').join("");
      select.value = adapters.includes(state.adapterFilter) ? state.adapterFilter : "";
      state.adapterFilter = select.value;
    }

    function filteredSessions() {
      const query = state.filterText.trim().toLowerCase();
      return state.sessions.filter((session) => {
        const adapter = session.sourceAdapter || "unknown";
        if (state.adapterFilter && adapter !== state.adapterFilter) return false;
        if (!query) return true;
        return [
          session.id,
          session.task,
          session.agent,
          session.model,
          session.repo,
          adapter
        ].some((value) => String(value || "").toLowerCase().includes(query));
      });
    }

    function renderEmpty() {
      document.getElementById("metrics").innerHTML = "";
      document.getElementById("decision").innerHTML = "";
      renderComparison(null);
      document.getElementById("timeline").innerHTML = '<div class="empty">No sessions found. Run agentops import first.</div>';
      document.getElementById("tab-risks").innerHTML = '<div class="empty">No risk data.</div>';
      document.getElementById("tab-tools").innerHTML = '<div class="empty">No tool calls.</div>';
      document.getElementById("tab-commands").innerHTML = '<div class="empty">No commands.</div>';
      document.getElementById("tab-files").innerHTML = '<div class="empty">No file changes.</div>';
      document.getElementById("report-link").classList.add("hidden");
      document.getElementById("evidence-link").classList.add("hidden");
      document.getElementById("compare-select").classList.add("hidden");
    }

    function renderDetail() {
      const data = state.detail;
      const session = data.session;
      const reportLink = document.getElementById("report-link");
      reportLink.href = "/api/sessions/" + encodeURIComponent(session.id) + "/report";
      reportLink.classList.remove("hidden");
      const evidenceLink = document.getElementById("evidence-link");
      evidenceLink.href = "/api/sessions/" + encodeURIComponent(session.id) + "/evidence";
      evidenceLink.classList.remove("hidden");
      document.getElementById("session-heading").textContent = session.id;
      document.getElementById("session-task").textContent = session.task || "Untitled task";
      document.getElementById("session-meta").innerHTML = [
        session.source_adapter || "unknown adapter",
        session.agent || "unknown agent",
        session.model || "unknown model",
        session.repo || "unknown repo"
      ].map((value) => '<span class="pill">' + escapeHtml(value) + '</span>').join("");
      document.getElementById("metrics").innerHTML = [
        metric("Events", data.events.length),
        metric("Commands", data.commands.length),
        metric("Files", data.files.length),
        metric("Tools", data.tools.length),
        metric("Risks", data.risks.length),
        metric("Verification", data.verification.length),
        metric("Tokens", data.usage.totalTokens == null ? "—" : fmt.format(data.usage.totalTokens))
      ].join("");
      renderDecision(data.decision);
      renderCompareSelect(session.id);
      if (state.compareId) loadComparison();
      else renderComparison(null);
      document.getElementById("timeline-count").textContent = data.events.length + " events";
      renderTimeline(data.events);
      renderRisks(data.riskDrilldown, data.verification);
      renderTools(data.tools);
      renderCommands(data.commands);
      renderFiles(data.files);
    }

    async function loadComparison() {
      if (!state.selectedId || !state.compareId) {
        renderComparison(null);
        return;
      }
      const response = await fetch("/api/compare?base=" + encodeURIComponent(state.compareId) + "&target=" + encodeURIComponent(state.selectedId));
      if (!response.ok) {
        renderComparison({ error: "Comparison unavailable." });
        return;
      }
      renderComparison(await response.json());
    }

    function renderCompareSelect(selectedId) {
      const select = document.getElementById("compare-select");
      const options = state.sessions.filter((session) => session.id !== selectedId);
      if (!options.length) {
        state.compareId = "";
        select.classList.add("hidden");
        renderComparison(null);
        return;
      }
      if (state.compareId === selectedId || !options.some((session) => session.id === state.compareId)) state.compareId = "";
      select.innerHTML = '<option value="">Compare with</option>' + options.map((session) => '<option value="' + escapeAttr(session.id) + '">' + escapeHtml(session.id) + '</option>').join("");
      select.value = state.compareId;
      select.classList.remove("hidden");
    }

    function renderComparison(comparison) {
      const container = document.getElementById("comparison");
      if (!comparison) {
        container.classList.add("hidden");
        container.innerHTML = "";
        return;
      }
      container.classList.remove("hidden");
      if (comparison.error) {
        container.innerHTML = '<div class="panel-body"><div class="empty">' + escapeHtml(comparison.error) + '</div></div>';
        return;
      }
      container.innerHTML =
        '<div class="panel-head"><h3>Run Comparison</h3><span class="subtle">' + escapeHtml(comparison.base.id) + ' to ' + escapeHtml(comparison.target.id) + '</span></div>' +
        '<div class="panel-body">' +
          '<div class="comparison-grid">' +
            comparisonMetric("Readiness", comparison.base.readiness + " to " + comparison.target.readiness, "neutral") +
            comparisonMetric("Risks", comparison.target.riskCount, deltaClass(comparison.deltas.riskCount, true), comparison.deltas.riskCount) +
            comparisonMetric("High risks", comparison.target.highRiskCount, deltaClass(comparison.deltas.highRiskCount, true), comparison.deltas.highRiskCount) +
            comparisonMetric("Verification", comparison.target.verificationCount, deltaClass(comparison.deltas.verificationCount, false), comparison.deltas.verificationCount) +
            comparisonMetric("Files", comparison.target.fileCount, deltaClass(comparison.deltas.fileCount, true), comparison.deltas.fileCount) +
            comparisonMetric("Commands", comparison.target.commandCount, deltaClass(comparison.deltas.commandCount, true), comparison.deltas.commandCount) +
            comparisonMetric("Tokens", comparison.target.totalTokens == null ? "—" : fmt.format(comparison.target.totalTokens), deltaClass(comparison.deltas.totalTokens, true), comparison.deltas.totalTokens) +
          '</div>' +
          '<div class="comparison-lists">' +
            (comparison.compatible.sameRepo ? "" : '<div class="mini-list"><h4>Compatibility</h4><div class="subtle">' + escapeHtml(comparison.compatible.message || "Sessions may not be comparable.") + '</div></div>') +
            miniList("Target-only files", comparison.files.targetOnly) +
            miniList("Target-only verification", comparison.verification.targetOnly) +
            miniList("Risk changes", comparison.risks.filter((risk) => risk.delta !== 0).map((risk) => risk.severity + " / " + risk.category + " " + formatSigned(risk.delta))) +
          '</div>' +
        '</div>';
    }

    function comparisonMetric(label, value, deltaClassName, delta) {
      const deltaHtml = delta == null ? "" : '<div class="delta ' + deltaClassName + '">' + formatSigned(delta) + '</div>';
      return '<div class="comparison-metric"><div class="metric-label">' + escapeHtml(label) + '</div><div class="comparison-value">' + escapeHtml(String(value)) + '</div>' + deltaHtml + '</div>';
    }

    function miniList(label, values) {
      const body = values.length ? '<ul>' + values.slice(0, 6).map((value) => '<li>' + escapeHtml(value) + '</li>').join("") + '</ul>' : '<div class="subtle">No changes.</div>';
      return '<div class="mini-list"><h4>' + escapeHtml(label) + '</h4>' + body + '</div>';
    }

    function deltaClass(delta, lowerIsBetter) {
      if (delta == null || delta === 0) return "neutral";
      const improved = lowerIsBetter ? delta < 0 : delta > 0;
      return improved ? "good" : "bad";
    }

    function formatSigned(value) {
      if (value == null) return "";
      return value > 0 ? "+" + value : String(value);
    }

    function renderDecision(decision) {
      const container = document.getElementById("decision");
      if (!decision) {
        container.innerHTML = "";
        return;
      }
      const readiness = decision.mergeReadiness;
      container.innerHTML =
        '<div class="panel readiness-card ' + escapeAttr(readiness.status) + '">' +
          '<div class="readiness-head">' +
            '<div><h3>Merge Readiness</h3><div class="readiness-title">' + escapeHtml(readiness.label) + '</div></div>' +
            '<span class="pill ' + readinessPillClass(readiness.status) + '">' + escapeHtml(readiness.status) + '</span>' +
          '</div>' +
          '<ul class="reason-list">' + readiness.reasons.map((reason) => '<li>' + escapeHtml(reason) + '</li>').join("") + '</ul>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3>Claim vs Evidence</h3><span class="subtle">' + decision.evidence.length + ' checks</span></div>' +
          '<div class="evidence-table">' +
            '<div class="evidence-row"><div>Check</div><div>Status</div><div>Evidence</div></div>' +
            decision.evidence.map(renderEvidenceRow).join("") +
          '</div>' +
        '</div>';
    }

    function renderEvidenceRow(row) {
      const detail = row.command
        ? '<code>' + escapeHtml(row.command) + '</code><div class="evidence-detail">' + escapeHtml(row.commandStatus || "unknown") + formatExit(row.commandExitCode) + '</div>'
        : row.riskMessage
          ? '<div class="evidence-detail">' + escapeHtml(row.riskMessage) + '</div>'
          : '<div class="evidence-detail">No claim recorded.</div>';
      return '<div class="evidence-row">' +
        '<div><strong>' + escapeHtml(row.label) + '</strong><div class="evidence-detail">' + (row.claimed ? 'Claimed' : 'Not claimed') + '</div></div>' +
        '<div><span class="pill ' + evidencePillClass(row.status) + '">' + escapeHtml(formatEvidenceStatus(row.status)) + '</span></div>' +
        '<div>' + detail + '</div>' +
      '</div>';
    }

    function renderTimeline(events) {
      const container = document.getElementById("timeline");
      if (!events.length) {
        container.innerHTML = '<div class="empty">No events recorded.</div>';
        return;
      }
      container.innerHTML = events.map((event) =>
        '<div class="event">' +
          '<div class="event-index">' + event.idx + '</div>' +
          '<div><div class="event-type">' + escapeHtml(event.type) + (event.role ? ' <span class="subtle">(' + escapeHtml(event.role) + ')</span>' : '') + '</div>' +
          '<div class="subtle">' + escapeHtml(event.summary) + '</div></div>' +
        '</div>'
      ).join("");
    }

    function renderRisks(drilldown, verification) {
      const container = document.getElementById("tab-risks");
      const riskHtml = drilldown && drilldown.groups.length
        ? '<h3 style="margin:0 0 8px">Risk Drilldown</h3>' + renderRiskSummary(drilldown.totals) + '<div class="list">' + drilldown.groups.map(renderRiskGroup).join("") + '</div>'
        : '<div class="empty">No risk flags detected.</div>';
      const evidenceHtml = verification.length
        ? '<h3 style="margin:14px 0 8px">Verification Evidence</h3><div class="list">' + verification.map((command) => '<div class="item"><code>' + escapeHtml(command.command) + '</code><div class="subtle">' + escapeHtml(command.status || "unknown") + formatExit(command.exitCode) + '</div></div>').join("") + '</div>'
        : '<h3 style="margin:14px 0 8px">Verification Evidence</h3><div class="empty">No verification command recorded.</div>';
      container.innerHTML = riskHtml + evidenceHtml;
    }

    function renderRiskSummary(totals) {
      return '<div class="risk-summary">' +
        '<span class="pill risk">' + totals.high + ' high</span>' +
        '<span class="pill neutral">' + totals.medium + ' medium</span>' +
        '<span class="pill neutral">' + totals.low + ' low</span>' +
        '<span class="pill">' + totals.total + ' total</span>' +
      '</div>';
    }

    function renderRiskGroup(group) {
      return '<div class="risk-group ' + escapeAttr(group.severity) + '">' +
        '<div class="risk-group-head"><span>' + escapeHtml(group.severity + " / " + group.category) + '</span><span class="pill">' + group.count + '</span></div>' +
        group.risks.map(renderRiskItem).join("") +
      '</div>';
    }

    function renderRiskItem(risk) {
      return '<div class="risk-item">' +
        '<div>' + escapeHtml(risk.message) + '</div>' +
        '<div class="risk-context">' + renderRiskContext(risk) + '</div>' +
      '</div>';
    }

    function renderRiskContext(risk) {
      const rows = [];
      if (risk.event) rows.push(contextLine("Event", "#" + risk.event.idx + " " + risk.event.type + " · " + risk.event.summary));
      if (risk.command) rows.push(contextLine("Command", '<code>' + escapeHtml(risk.command.command) + '</code><div>' + escapeHtml(risk.command.status || "unknown") + formatExit(risk.command.exitCode) + '</div>', true));
      if (risk.file) rows.push(contextLine("File", '<code>' + escapeHtml(risk.file.path) + '</code><div>' + escapeHtml(risk.file.operation) + formatChurn(risk.file) + '</div>', true));
      if (risk.evidence) rows.push(contextLine("Evidence", risk.evidence.label + " · " + formatEvidenceStatus(risk.evidence.status)));
      return rows.length ? rows.join("") : contextLine("Context", "No linked event context recorded.");
    }

    function contextLine(label, value, valueIsHtml) {
      return '<div class="context-line"><div class="context-label">' + escapeHtml(label) + '</div><div>' + (valueIsHtml ? value : escapeHtml(value)) + '</div></div>';
    }

    function renderCommands(commands) {
      const container = document.getElementById("tab-commands");
      container.innerHTML = commands.length
        ? '<div class="list">' + commands.map((command) => '<div class="item"><code>' + escapeHtml(command.command) + '</code><div class="subtle">' + escapeHtml(command.status || "unknown") + formatExit(command.exitCode) + '</div></div>').join("") + '</div>'
        : '<div class="empty">No commands recorded.</div>';
    }

    function renderTools(tools) {
      const container = document.getElementById("tab-tools");
      container.innerHTML = tools.length
        ? '<div class="list">' + tools.map((tool) => '<div class="item tool-row"><div><code>' + escapeHtml(tool.toolName) + '</code><div class="tool-category">' + escapeHtml(tool.category) + (tool.status ? ' · ' + escapeHtml(tool.status) : '') + '</div></div><span class="pill">' + tool.count + '</span></div>').join("") + '</div>'
        : '<div class="empty">No tool calls recorded.</div>';
    }

    function renderFiles(files) {
      const container = document.getElementById("tab-files");
      container.innerHTML = files.length
        ? '<div class="list">' + files.map((file) => '<div class="item"><code>' + escapeHtml(file.path) + '</code><div class="subtle">' + escapeHtml(file.operation) + formatChurn(file) + '</div></div>').join("") + '</div>'
        : '<div class="empty">No file changes recorded.</div>';
    }

    function selectTab(name) {
      for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.tab === name);
      for (const id of ["risks", "tools", "commands", "files"]) document.getElementById("tab-" + id).classList.toggle("hidden", id !== name);
    }

    function metric(label, value) {
      return '<div class="metric"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(String(value)) + '</div></div>';
    }

    function readinessPillClass(status) {
      if (status === "ready") return "ok";
      if (status === "blocked") return "risk";
      return "neutral";
    }

    function evidencePillClass(status) {
      if (status === "verified") return "ok";
      if (status === "missing-evidence") return "missing";
      return "neutral";
    }

    function formatEvidenceStatus(status) {
      if (status === "verified") return "Evidence found";
      if (status === "missing-evidence") return "Missing evidence";
      return "Not claimed";
    }

    function formatExit(exitCode) {
      return exitCode == null ? "" : ", exit " + exitCode;
    }

    function formatChurn(file) {
      const parts = [];
      if (file.linesAdded != null) parts.push("+" + file.linesAdded);
      if (file.linesRemoved != null) parts.push("-" + file.linesRemoved);
      return parts.length ? " (" + parts.join(" / ") + ")" : "";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }
  </script>
</body>
</html>`;
}
