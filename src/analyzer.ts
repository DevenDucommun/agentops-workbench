import type { Store } from "./store";
import { getCommands, getEvents, getFileChanges } from "./store";

type RiskFlag = {
  eventId: number | null;
  severity: "low" | "medium" | "high";
  category: string;
  message: string;
};

const destructiveCommandPattern = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|drop\s+database|truncate\s+table|mkfs|chmod\s+-R\s+777|sudo\s+rm)\b/i;
const permissionCommandPattern = /\b(chmod|chown|setfacl)\b/i;
const testCommandPattern = /\b(bun|npm|pnpm|yarn|pytest|cargo|go|make|gmake|mvn|gradle)\s+([^\n]*\b)?(test|check|lint|typecheck|verify)\b/i;
const secretPattern = /\b(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----)\b/;
const sensitivePathPattern = /(^|\/)(\.env|\.npmrc|\.pypirc|id_rsa|id_ed25519|secrets?\.(json|ya?ml|toml)|kubeconfig|credentials)(\.|$|\/)/i;
const productionConfigPattern = /(^|\/)(prod|production|terraform|helm|k8s|kubernetes|deploy|release)(\/|\.|-|_)/i;

export function analyzeSession(store: Store, sessionId: string): void {
  const db = store.db;
  db.query("DELETE FROM risk_flags WHERE session_id = $sessionId").run({ $sessionId: sessionId });

  const flags: RiskFlag[] = [];
  const commands = getCommands(store, sessionId);
  const fileChanges = getFileChanges(store, sessionId);
  const events = getEvents(store, sessionId);

  for (const command of commands) {
    if (destructiveCommandPattern.test(command.command)) {
      flags.push({
        eventId: command.eventId,
        severity: "high",
        category: "destructive-command",
        message: `Destructive command detected: ${command.command}`
      });
    }
    if (permissionCommandPattern.test(command.command)) {
      flags.push({
        eventId: command.eventId,
        severity: "medium",
        category: "permission-change",
        message: `Permission-changing command detected: ${command.command}`
      });
    }
    if (command.output && secretPattern.test(command.output)) {
      flags.push({
        eventId: command.eventId,
        severity: "high",
        category: "secret-exposure",
        message: "Command output contains a secret-looking value."
      });
    }
  }

  for (const file of fileChanges) {
    if (sensitivePathPattern.test(file.path)) {
      flags.push({
        eventId: file.eventId,
        severity: "high",
        category: "sensitive-file",
        message: `Sensitive file changed: ${file.path}`
      });
    }
    if (productionConfigPattern.test(file.path)) {
      flags.push({
        eventId: file.eventId,
        severity: "medium",
        category: "production-config",
        message: `Production or deployment config changed: ${file.path}`
      });
    }
    const churn = (file.linesAdded ?? 0) + (file.linesRemoved ?? 0);
    if (churn >= 500) {
      flags.push({
        eventId: file.eventId,
        severity: "medium",
        category: "large-churn",
        message: `Large file churn in ${file.path}: ${churn} changed lines`
      });
    }
  }

  const ranVerification = commands.some((command) => testCommandPattern.test(command.command));
  const finalEvent = [...events].reverse().find((event) => event.type === "final_response");
  if (finalEvent && claimsSuccess(finalEvent.summary) && !ranVerification) {
    flags.push({
      eventId: finalEvent.id,
      severity: "medium",
      category: "unsupported-success-claim",
      message: "Final response claims success, but no test/lint/check command was recorded."
    });
  }

  for (const event of events) {
    if (secretPattern.test(event.rawJson)) {
      flags.push({
        eventId: event.id,
        severity: "high",
        category: "secret-exposure",
        message: "Transcript event contains a secret-looking value."
      });
    }
  }

  const insert = db.query(`
    INSERT INTO risk_flags (session_id, event_id, severity, category, message)
    VALUES ($sessionId, $eventId, $severity, $category, $message)
  `);
  db.transaction(() => {
    for (const flag of flags) {
      insert.run({
        $sessionId: sessionId,
        $eventId: flag.eventId,
        $severity: flag.severity,
        $category: flag.category,
        $message: flag.message
      });
    }
  })();
}

export function isVerificationCommand(command: string): boolean {
  return testCommandPattern.test(command);
}

function claimsSuccess(value: string): boolean {
  return /\b(done|complete|completed|success|successful|fixed|implemented|passed|working)\b/i.test(value);
}
