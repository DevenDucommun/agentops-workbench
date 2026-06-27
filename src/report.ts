import { isVerificationCommand } from "./analyzer";
import { getCommands, getEvents, getFileChanges, getRiskFlags, getSession, type Store } from "./store";

export function generateMarkdownReport(store: Store, sessionId: string): string {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const events = getEvents(store, sessionId);
  const commands = getCommands(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const verification = commands.filter((command) => isVerificationCommand(command.command));
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
