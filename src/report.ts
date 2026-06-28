import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { isVerificationCommand } from "./analyzer";
import { getCommands, getEvents, getFileChanges, getRiskFlags, getSession, type Store } from "./store";
import type { GitChange } from "./git";

export function generateMarkdownReport(store: Store, sessionId: string, config: AgentOpsConfig = defaultConfig): string {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const events = getEvents(store, sessionId);
  const commands = getCommands(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const verification = commands.filter((command) => isVerificationCommand(command.command, config));
  const final = [...events].reverse().find((event) => event.type === "final_response");

  const sections = [
    "# AgentOps Session Report",
    "## Session Summary",
    table([
      ["Session", session.id],
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
    "## Timeline",
    events.length
      ? events.map((event) => `- ${event.idx}. **${event.type}**${event.role ? ` (${event.role})` : ""}: ${event.summary}`).join("\n")
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
      ? verification.map((command) => `- \`${command.command}\``).join("\n")
      : "- No test, lint, typecheck, or verification command recorded.",
    "## Risk Flags",
    risks.length
      ? risks.map((risk) => `- **${risk.severity} / ${risk.category}**: ${risk.message}`).join("\n")
      : "- No risk flags detected.",
    "## Final Outcome",
    final ? final.summary : "No final response recorded."
  ];

  return `${sections.join("\n\n")}\n`;
}

export function generateMarkdownRepoReport(
  store: Store,
  sessionId: string,
  gitChanges: GitChange[],
  config: AgentOpsConfig = defaultConfig
): string {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const commands = getCommands(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const verification = commands.filter((command) => isVerificationCommand(command.command, config));
  const agentPaths = new Set(files.map((file) => file.path));
  const gitPaths = new Set(gitChanges.map((change) => change.path));
  const observedGitChanges = gitChanges.filter((change) => agentPaths.has(change.path));
  const unobservedGitChanges = gitChanges.filter((change) => !agentPaths.has(change.path));
  const agentOnlyFiles = files.filter((file) => !gitPaths.has(file.path));

  const sections = [
    "# AgentOps Repo Report",
    "## Review Summary",
    table([
      ["Session", session.id],
      ["Task", session.task ?? "Unknown"],
      ["Repo", session.repo ?? "Unknown"],
      ["Git Changed Files", String(gitChanges.length)],
      ["Agent Files Touched", String(files.length)],
      ["Git Files Observed In Session", String(observedGitChanges.length)],
      ["Git Files Not Observed In Session", String(unobservedGitChanges.length)],
      ["Risk Flags", String(risks.length)],
      ["Verification Commands", String(verification.length)]
    ]),
    "## Current Git Changes",
    gitChanges.length
      ? gitChanges.map((change) => `- \`${change.path}\` - ${change.status}${formatGitChurn(change)}`).join("\n")
      : "- No git changes detected.",
    "## Session Coverage",
    coverageSummary(observedGitChanges, unobservedGitChanges, agentOnlyFiles),
    "## Verification Evidence",
    verification.length
      ? verification.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}`).join("\n")
      : "- No test, lint, typecheck, build, or verification command recorded.",
    "## Risk Flags",
    risks.length
      ? risks.map((risk) => `- **${risk.severity} / ${risk.category}**: ${risk.message}`).join("\n")
      : "- No risk flags detected.",
    "## Commands Run",
    commands.length
      ? commands.map((command) => `- \`${command.command}\` - ${command.status ?? "unknown"}`).join("\n")
      : "- No commands recorded."
  ];

  return `${sections.join("\n\n")}\n`;
}

function table(rows: Array<[string, string]>): string {
  return ["| Field | Value |", "| --- | --- |", ...rows.map(([field, value]) => `| ${field} | ${escapeTable(value)} |`)].join("\n");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function formatChurn(added: number | null, removed: number | null): string {
  const parts = [];
  if (added !== null) parts.push(`+${added}`);
  if (removed !== null) parts.push(`-${removed}`);
  return parts.join(" / ");
}

function formatGitChurn(change: GitChange): string {
  const churn = formatChurn(change.additions, change.deletions);
  return churn ? ` (${churn})` : "";
}

function coverageSummary(observed: GitChange[], unobserved: GitChange[], agentOnly: ReturnType<typeof getFileChanges>): string {
  const sections = [];
  sections.push("### Git Changes Observed In Session");
  sections.push(observed.length ? observed.map((change) => `- \`${change.path}\``).join("\n") : "- None.");
  sections.push("### Git Changes Not Observed In Session");
  sections.push(unobserved.length ? unobserved.map((change) => `- \`${change.path}\``).join("\n") : "- None.");
  sections.push("### Agent-Touched Files Not In Current Git Diff");
  sections.push(agentOnly.length ? agentOnly.map((file) => `- \`${file.path}\` - ${file.operation}`).join("\n") : "- None.");
  return sections.join("\n\n");
}
