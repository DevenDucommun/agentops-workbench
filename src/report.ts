import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { isVerificationCommand } from "./analyzer";
import { evaluateQualityGate, formatGateGithub } from "./gate";
import { type ClaimsLedger, commandOutcome, getClaimsLedger, hasRecordedOutcome, type LedgerEvidence } from "./ledger";
import { getCommands, getEvents, getFileChanges, getRiskFlags, getSession, getUsageSummary, type Store } from "./store";
import { displayGitPath, type GitChange } from "./git";
import type { UsageSummary } from "./types";

type RepoReportData = {
  session: NonNullable<ReturnType<typeof getSession>>;
  commands: ReturnType<typeof getCommands>;
  files: ReturnType<typeof getFileChanges>;
  risks: ReturnType<typeof getRiskFlags>;
  usage: UsageSummary;
  verification: ReturnType<typeof getCommands>;
  gitChanges: GitChange[];
  observedGitChanges: GitChange[];
  unobservedGitChanges: GitChange[];
  agentOnlyFiles: ReturnType<typeof getFileChanges>;
};

export function generateMarkdownReport(store: Store, sessionId: string, config: AgentOpsConfig = defaultConfig): string {
  return store.db.transaction(() => renderMarkdownReport(store, sessionId, config))();
}

function renderMarkdownReport(store: Store, sessionId: string, config: AgentOpsConfig): string {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const events = getEvents(store, sessionId);
  const commands = getCommands(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const usage = getUsageSummary(store, sessionId);
  const verification = commands.filter((command) => isVerificationCommand(command, config));
  const final = [...events].reverse().find((event) => event.type === "final_response");
  const ledger = getClaimsLedger(store, sessionId, config);
  const citedEvents = new Set(ledger.claims.map(claim => claim.cited?.eventRowId));

  const sections = [
    "# AgentOps Session Report",
    "## Session Summary",
    table([
      ["Session", session.id],
      ["Adapter", session.source_adapter ?? "Unknown"],
      ["Task", session.task ?? "Unknown"],
      ["Agent", session.agent ?? "Unknown"],
      ["Model", session.model ?? "Unknown"],
      ["Repo", session.repo ?? "Unknown"],
      ["Started", session.started_at ?? "Unknown"],
      ["Ended", session.ended_at ?? "Unknown"],
      ["Events", String(events.length)],
      ["Commands", String(commands.length)],
      ["Files Changed", String(files.length)],
      ["Risk Flags", String(risks.length)]
    ]),
    ...(ledger.evidenceLimitation ? [ledger.evidenceLimitation] : []),
    ...forensicEvidenceQuality(session.source_adapter),
    ...(hasUsage(usage) ? ["## Usage", usageTable(usage)] : []),
    "## Timeline",
    events.length
      ? events.map((event) => `- ${citedEvents.has(event.id) ? `<a id="event-step-${event.idx}"></a>` : ""}${event.idx}. **${event.type}**${event.role ? ` (${event.role})` : ""}: ${event.summary}`).join("\n")
      : "- No events recorded.",
    "## Files Touched",
    files.length
      ? files
          .map((file) => {
            const churn = formatChurn(file.linesAdded, file.linesRemoved);
            return `- \`${file.path}\` - ${file.operation}${churn ? ` (${churn})` : ""}`;
          })
          .join("\n")
      : "- No file changes recorded.",
    "## Commands Run",
    commands.length
      ? commands
          .map((command) => {
            const status = command.status ?? "unknown";
            const exitCode = command.exitCode === null ? "" : `, exit ${command.exitCode}`;
            return `- \`${command.command}\` - ${status}${exitCode}`;
          })
          .join("\n")
      : "- No commands recorded.",
    "## Tests And Verification Evidence",
    verification.length
      ? verification.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}${formatExit(command.exitCode)}`).join("\n")
      : "- No test, lint, typecheck, or verification command recorded.",
    ...(ledger.claims.length ? ["## Claims Ledger", formatLedger(ledger, events, true)] : []),
    "## Risk Flags",
    formatRiskFlags(risks),
    "## Final Outcome",
    final ? final.summary : "No final response recorded."
  ];

  return `${sections.join("\n\n")}\n`;
}

function forensicEvidenceQuality(sourceAdapter: string | null): string[] {
  if (sourceAdapter !== "forensic-text") return [];
  return [
    "## Evidence Quality",
    [
      "- Source is a plain-text forensic import, not a provider JSONL capture.",
      "- Shell-prompt commands are labeled `observed`; narrative command/file mentions are labeled `inferred`.",
      "- Missing commands or verification should be treated as missing evidence, not proof that work was not performed."
    ].join("\n")
  ];
}

export function generateMarkdownRepoReport(
  store: Store,
  sessionId: string,
  gitChanges: GitChange[],
  config: AgentOpsConfig = defaultConfig
): string {
  const data = buildRepoReportData(store, sessionId, gitChanges, config);

  const sections = [
    "# AgentOps Repo Report",
    "## Review Summary",
    table([
      ["Session", data.session.id],
      ["Task", data.session.task ?? "Unknown"],
      ["Repo", data.session.repo ?? "Unknown"],
      ["Git Changed Files", String(data.gitChanges.length)],
      ["Agent Files Touched", String(data.files.length)],
      ["Git Files Observed In Session", String(data.observedGitChanges.length)],
      ["Git Files Not Observed In Session", String(data.unobservedGitChanges.length)],
      ["Risk Flags", String(data.risks.length)],
      ["Verification Commands", String(data.verification.length)],
      ...(hasUsage(data.usage) ? usageRows(data.usage) : [])
    ]),
    "## Current Git Changes",
    data.gitChanges.length
      ? data.gitChanges.map((change) => `- \`${displayGitPath(change.path)}\` - ${change.status}${formatGitChurn(change)}`).join("\n")
      : "- No git changes detected.",
    "## Session Coverage",
    coverageSummary(data.observedGitChanges, data.unobservedGitChanges, data.agentOnlyFiles),
    "## Verification Evidence",
    data.verification.length
      ? data.verification.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}`).join("\n")
      : "- No test, lint, typecheck, build, or verification command recorded.",
    "## Risk Flags",
    formatRiskFlags(data.risks),
    "## Commands Run",
    data.commands.length
      ? data.commands.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}`).join("\n")
      : "- No commands recorded."
  ];

  return `${sections.join("\n\n")}\n`;
}

export function generateGithubRepoComment(
  store: Store,
  sessionId: string,
  gitChanges: GitChange[],
  config: AgentOpsConfig = defaultConfig
): string {
  return store.db.transaction(() => renderGithubRepoComment(store, sessionId, gitChanges, config))();
}

function renderGithubRepoComment(store: Store, sessionId: string, gitChanges: GitChange[], config: AgentOpsConfig): string {
  const data = buildRepoReportData(store, sessionId, gitChanges, config);
  const ledger = getClaimsLedger(store, sessionId, config);
  const status = data.risks.some((risk) => risk.severity === "high")
    ? "High-risk findings present"
    : data.risks.length > 0
      ? "Review recommended"
      : "No risk flags detected";

  const sections = [
    "## AgentOps Workbench Report",
    `**Status:** ${status}`,
    formatGateGithub(evaluateQualityGate(store, sessionId, config, { gitChanges })).trim(),
    table([
      ["Session", data.session.id],
      ["Task", data.session.task ?? "Unknown"],
      ["Git changed files", String(data.gitChanges.length)],
      ["Observed in session", String(data.observedGitChanges.length)],
      ["Not observed in session", String(data.unobservedGitChanges.length)],
      ["Risk flags", String(data.risks.length)],
      ["Verification commands", String(data.verification.length)],
      ...(hasUsage(data.usage) ? usageRows(data.usage) : [])
    ]),
    "### Verification",
    data.verification.length
      ? data.verification.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}`).join("\n")
      : "- No verification command recorded.",
    ...(ledger.claims.length ? ["### Claims", formatLedger(ledger, getEvents(store, sessionId), false)] : []),
    "### Risk Flags",
    formatRiskFlags(data.risks, 4),
    "### Git Changes Not Observed In Session",
    data.unobservedGitChanges.length
      ? data.unobservedGitChanges.map((change) => `- \`${displayGitPath(change.path)}\``).join("\n")
      : "- None.",
    `<details><summary>Commands run</summary>\n\n${
      data.commands.length ? data.commands.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}`).join("\n") : "- None."
    }\n\n</details>`,
    "_Generated locally by AgentOps Workbench. This command does not post to GitHub._"
  ];

  return `${sections.join("\n\n")}\n`;
}

/** GitHub job summaries and sticky comments use the same citations as the PR report. */
export function githubGateEvidence(store: Store, sessionId: string, config: AgentOpsConfig): string[] {
  const ledger = getClaimsLedger(store, sessionId, config);
  const cited = new Set(ledger.claims.map(claim => claim.cited?.eventRowId));
  const failures = getCommands(store, sessionId).filter(run =>
    (run.eventId === null || !cited.has(run.eventId)) && hasRecordedOutcome(run) && commandOutcome(run) === "failed" && isVerificationCommand(run, config)
  );
  if (!ledger.claims.length && !failures.length) return [];
  const events = store.db.query("SELECT id, idx FROM events WHERE session_id = ?").all(sessionId) as Array<{ id: number; idx: number }>;
  const sections = ledger.claims.length ? ["### Claims", formatLedger(ledger, events, false)] : [];
  if (failures.length) {
    const steps = new Map(events.map(event => [event.id, event.idx]));
    // Keep a long retry history from crowding out the current claim verdict.
    const recent = failures.slice(-5);
    const lines = recent.map(run => "- " + formatRun(run, stepRef({ eventRowId: run.eventId, eventId: null }, steps, false)));
    if (failures.length > recent.length) lines.push(`Showing the latest ${recent.length} of ${failures.length} uncited failures.`);
    sections.push("### Other recorded verification failures", lines.join("\n"));
  }
  return sections;
}

function formatRun(run: Pick<LedgerEvidence, "command" | "status" | "exitCode">, reference: string): string {
  let outcome = run.exitCode === null ? run.status : `exit ${run.exitCode}`;
  if (run.exitCode === 0 && commandOutcome(run) === "failed") outcome += `, ${run.status}`;
  return `${codeSpan(run.command)}${outcome ? ` (${outcome})` : ""}, ${reference}`;
}

function codeSpan(text: string): string {
  let width = 1;
  for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "`".repeat(width);
  const value = text.replace(/[\r\n]+/g, " ");
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

const VERDICT_LABELS = { supported: "Supported", contradicted: "Contradicted", unsupported: "Unsupported", stale: "Rerun needed", unverified: "Unverified" } as const;

/** One row per claim in the final response: its verdict and the run it rests on (spec R2.5). */
function formatLedger(ledger: ClaimsLedger, events: Array<{ id: number; idx: number }>, linkTimeline: boolean): string {
  const steps = new Map(events.map((event) => [event.id, event.idx]));
  const rows = ledger.claims.map((claim) => {
    const evidence = claim.cited
      ? formatRun(claim.cited, stepRef(claim.cited, steps, linkTimeline))
      : claim.reason;
    const detail = claim.verdict === "stale" || claim.verdict === "unverified" ? `${evidence}. ${claim.reason}` : evidence;
    return `| ${escapeTable(claim.label)} | ${VERDICT_LABELS[claim.verdict]} | ${escapeTable(detail)} |`;
  });
  return ["| Claim | Verdict | Evidence |", "| --- | --- | --- |", ...rows].join("\n");
}

/** The timeline step that recorded a run, plus its source eventId when there is one. */
function stepRef(evidence: Pick<LedgerEvidence, "eventRowId" | "eventId">, steps: Map<number, number>, linkTimeline: boolean): string {
  const step = evidence.eventRowId === null ? undefined : steps.get(evidence.eventRowId);
  const label = step === undefined ? "unlinked event" : linkTimeline ? `[step ${step}](#event-step-${step})` : `step ${step}`;
  if (!evidence.eventId) return label;
  const id = /^[a-zA-Z0-9_.:-]+$/.test(evidence.eventId) ? evidence.eventId : codeSpan(evidence.eventId);
  return `${label} (${id})`;
}

function table(rows: Array<[string, string]>): string {
  return ["| Field | Value |", "| --- | --- |", ...rows.map(([field, value]) => `| ${field} | ${escapeTable(value)} |`)].join("\n");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function formatRiskFlags(risks: ReturnType<typeof getRiskFlags>, headingDepth = 3): string {
  if (!risks.length) return "- No risk flags detected.";

  const headings = {
    high: "High Severity",
    medium: "Medium Severity",
    low: "Low Severity"
  };
  const headingPrefix = "#".repeat(headingDepth);
  const sections = [];
  for (const severity of ["high", "medium", "low"] as const) {
    const group = risks.filter((risk) => risk.severity === severity);
    if (!group.length) continue;
    sections.push(`${headingPrefix} ${headings[severity]}`);
    sections.push(group.map((risk) => `- **${risk.category}**: ${risk.message}`).join("\n"));
  }
  return sections.join("\n\n");
}

function formatChurn(added: number | null, removed: number | null): string {
  const parts = [];
  if (added !== null) parts.push(`+${added}`);
  if (removed !== null) parts.push(`-${removed}`);
  return parts.join(" / ");
}

function formatExit(exitCode: number | null): string {
  return exitCode === null ? "" : `, exit ${exitCode}`;
}

function formatGitChurn(change: GitChange): string {
  const churn = formatChurn(change.additions, change.deletions);
  return churn ? ` (${churn})` : "";
}

function coverageSummary(observed: GitChange[], unobserved: GitChange[], agentOnly: ReturnType<typeof getFileChanges>): string {
  const sections = [];
  sections.push("### Git Changes Observed In Session");
  sections.push(observed.length ? observed.map((change) => `- \`${displayGitPath(change.path)}\``).join("\n") : "- None.");
  sections.push("### Git Changes Not Observed In Session");
  sections.push(unobserved.length ? unobserved.map((change) => `- \`${displayGitPath(change.path)}\``).join("\n") : "- None.");
  sections.push("### Agent-Touched Files Not In Current Git Diff");
  sections.push(agentOnly.length ? agentOnly.map((file) => `- \`${file.path}\` - ${file.operation}`).join("\n") : "- None.");
  return sections.join("\n\n");
}

function buildRepoReportData(
  store: Store,
  sessionId: string,
  gitChanges: GitChange[],
  config: AgentOpsConfig
): RepoReportData {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const commands = getCommands(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const usage = getUsageSummary(store, sessionId);
  const verification = commands.filter((command) => isVerificationCommand(command, config));
  const agentPaths = new Set(files.map((file) => file.path));
  const gitPaths = new Set(gitChanges.map((change) => change.path));

  return {
    session,
    commands,
    files,
    risks,
    usage,
    verification,
    gitChanges,
    observedGitChanges: gitChanges.filter((change) => agentPaths.has(change.path)),
    unobservedGitChanges: gitChanges.filter((change) => !agentPaths.has(change.path)),
    agentOnlyFiles: files.filter((file) => !gitPaths.has(file.path))
  };
}

function hasUsage(usage: UsageSummary): boolean {
  return usageRows(usage).length > 0;
}

function usageTable(usage: UsageSummary): string {
  return table(usageRows(usage));
}

function usageRows(usage: UsageSummary): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (usage.inputTokens !== null) rows.push(["Input Tokens", formatInteger(usage.inputTokens)]);
  if (usage.outputTokens !== null) rows.push(["Output Tokens", formatInteger(usage.outputTokens)]);
  if (usage.totalTokens !== null) rows.push(["Total Tokens", formatInteger(usage.totalTokens)]);
  if (usage.costAmount !== null) rows.push(["Cost", formatCost(usage.costAmount, usage.costCurrency)]);
  return rows;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCost(amount: number, currency: string | null): string {
  const formattedAmount = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  }).format(amount);
  return currency ? `${formattedAmount} ${currency}` : formattedAmount;
}
