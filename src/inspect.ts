import { isVerificationCommand } from "./analyzer";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { getCommands, getEvents, getFileChanges, getRiskFlags, getSession, getUsageSummary, listSessions, type Store } from "./store";
import type { UsageSummary } from "./types";

export function generateSessionList(store: Store, limit = 20): string {
  const sessions = listSessions(store, limit);
  if (sessions.length === 0) return "No sessions found. Run `agentops import <session.jsonl>` first.\n";

  const rows = sessions.map((session) => [
    session.id,
    session.sourceAdapter ?? "unknown",
    session.agent ?? "unknown",
    session.repo ?? "unknown",
    String(session.eventCount),
    String(session.riskCount),
    session.totalTokens === null ? "" : formatInteger(session.totalTokens),
    session.ingestedAt
  ]);

  return `${table(["Session", "Adapter", "Agent", "Repo", "Events", "Risks", "Tokens", "Ingested"], rows)}\n`;
}

export function generateSessionInspection(
  store: Store,
  sessionId: string,
  config: AgentOpsConfig = defaultConfig
): string {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const events = getEvents(store, sessionId);
  const commands = getCommands(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const usage = getUsageSummary(store, sessionId);
  const verification = commands.filter((command) => isVerificationCommand(command.command, config));
  const final = [...events].reverse().find((event) => event.type === "final_response");

  const sections = [
    "# AgentOps Session Inspection",
    "## Summary",
    fieldTable([
      ["Session", session.id],
      ["Adapter", session.source_adapter ?? "Unknown"],
      ["Schema", session.schema_version ?? "Unknown"],
      ["Agent", session.agent ?? "Unknown"],
      ["Model", session.model ?? "Unknown"],
      ["Repo", session.repo ?? "Unknown"],
      ["Task", session.task ?? "Unknown"],
      ["Ingested", session.ingested_at],
      ["Events", String(events.length)],
      ["Commands", String(commands.length)],
      ["Files Changed", String(files.length)],
      ["Risk Flags", String(risks.length)],
      ["Verification Commands", String(verification.length)],
      ...usageRows(usage)
    ]),
    ...forensicEvidenceQuality(session.source_adapter),
    "## Timeline",
    events.length
      ? events.map((event) => `- ${event.idx}. **${event.type}**${event.role ? ` (${event.role})` : ""}: ${event.summary}`).join("\n")
      : "- No events recorded.",
    "## Commands",
    commands.length
      ? commands.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}${formatExit(command.exitCode)}`).join("\n")
      : "- No commands recorded.",
    "## Files",
    files.length
      ? files.map((file) => `- \`${file.path}\` - ${file.operation}${formatChurn(file.linesAdded, file.linesRemoved)}`).join("\n")
      : "- No file changes recorded.",
    "## Risk Flags",
    risks.length
      ? risks.map((risk) => `- **${risk.severity} / ${risk.category}**: ${risk.message}`).join("\n")
      : "- No risk flags detected.",
    "## Final Outcome",
    final?.summary ?? "No final response recorded."
  ];

  return `${sections.join("\n\n")}\n`;
}

function forensicEvidenceQuality(sourceAdapter: string | null): string[] {
  if (sourceAdapter !== "forensic-text") return [];
  return [
    "## Evidence Quality",
    [
      "- Plain-text forensic import: lower-fidelity than provider JSONL.",
      "- Command statuses distinguish observed shell prompts from inferred narrative mentions.",
      "- Prefer `agentops run` or provider JSONL when you need full-fidelity evidence."
    ].join("\n")
  ];
}

export function formatAdapterList(adapters: Array<{ id: string; displayName: string; artifactHint: string }>): string {
  const rows = adapters.map((adapter) => [adapter.id, adapter.displayName, adapter.artifactHint]);
  return `${table(["Adapter", "Name", "Artifact"], rows)}\n`;
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTable).join(" | ")} |`)
  ].join("\n");
}

function fieldTable(rows: Array<[string, string]>): string {
  return table(["Field", "Value"], rows);
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function formatExit(exitCode: number | null): string {
  return exitCode === null ? "" : `, exit ${exitCode}`;
}

function formatChurn(added: number | null, removed: number | null): string {
  const parts = [];
  if (added !== null) parts.push(`+${added}`);
  if (removed !== null) parts.push(`-${removed}`);
  return parts.length ? ` (${parts.join(" / ")})` : "";
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
