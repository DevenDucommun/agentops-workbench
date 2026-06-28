import type { AgentOpsConfig, RiskSuppression } from "./config";
import { defaultConfig } from "./config";
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
const secretPattern = /\b(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----)\b/;
const credentialRedactionPattern = /\[REDACTED:(aws-access-key|openai-style-key|github-token|slack-token|private-key)\]/;
const privacyRedactionPattern = /\[REDACTED:(email|local-path)\]/;

export function analyzeSession(store: Store, sessionId: string, config: AgentOpsConfig = defaultConfig): void {
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
    if (command.output && credentialRedactionPattern.test(command.output)) {
      flags.push({
        eventId: command.eventId,
        severity: "high",
        category: "secret-redaction",
        message: "Command output contained a credential-like value that was redacted."
      });
    }
    if (command.output && privacyRedactionPattern.test(command.output)) {
      flags.push({
        eventId: command.eventId,
        severity: "medium",
        category: "privacy-redaction",
        message: "Command output contained personal or local-environment data that was redacted."
      });
    }
  }

  for (const file of fileChanges) {
    if (isSensitivePath(file.path, config)) {
      flags.push({
        eventId: file.eventId,
        severity: "high",
        category: "sensitive-file",
        message: `Sensitive file changed: ${file.path}`
      });
    }
    if (isProductionPath(file.path, config)) {
      flags.push({
        eventId: file.eventId,
        severity: "medium",
        category: "production-config",
        message: `Production or deployment config changed: ${file.path}`
      });
    }
    const churn = (file.linesAdded ?? 0) + (file.linesRemoved ?? 0);
    if (churn >= config.risk.largeChurnLines) {
      flags.push({
        eventId: file.eventId,
        severity: "medium",
        category: "large-churn",
        message: `Large file churn in ${file.path}: ${churn} changed lines`
      });
    }
  }

  const ranVerification = commands.some((command) => isVerificationCommand(command.command, config));
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
    if (credentialRedactionPattern.test(event.rawJson)) {
      flags.push({
        eventId: event.id,
        severity: "high",
        category: "secret-redaction",
        message: "Transcript event contained a credential-like value that was redacted."
      });
    }
    if (privacyRedactionPattern.test(event.rawJson)) {
      flags.push({
        eventId: event.id,
        severity: "medium",
        category: "privacy-redaction",
        message: "Transcript event contained personal or local-environment data that was redacted."
      });
    }
  }

  const unsuppressedFlags = flags.filter((flag) => !isSuppressed(flag, config.suppressions));

  const insert = db.query(`
    INSERT INTO risk_flags (session_id, event_id, severity, category, message)
    VALUES ($sessionId, $eventId, $severity, $category, $message)
  `);
  db.transaction(() => {
    for (const flag of unsuppressedFlags) {
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

export function isVerificationCommand(command: string, config: AgentOpsConfig = defaultConfig): boolean {
  const keywords = config.evidence.verificationCommands.map(escapeRegex).join("|");
  const pattern = new RegExp(`\\b(bun|npm|pnpm|yarn|pytest|cargo|go|make|gmake|mvn|gradle)\\s+([^\\n]*\\b)?(${keywords})\\b`, "i");
  return pattern.test(command);
}

function claimsSuccess(value: string): boolean {
  return /\b(done|complete|completed|success|successful|fixed|implemented|passed|working)\b/i.test(value);
}

function isSensitivePath(path: string, config: AgentOpsConfig): boolean {
  return config.risk.sensitivePaths.some((entry) => path === entry || path.endsWith(`/${entry}`) || path.includes(`/${entry}.`));
}

function isProductionPath(path: string, config: AgentOpsConfig): boolean {
  return config.risk.productionPathPatterns.some((entry) => {
    const pattern = new RegExp(`(^|/)${escapeRegex(entry)}(/|\\.|-|_)`, "i");
    return pattern.test(path);
  });
}

function isSuppressed(flag: RiskFlag, suppressions: RiskSuppression[]): boolean {
  return suppressions.some((suppression) => {
    if (suppression.category && suppression.category !== flag.category) return false;
    if (suppression.command && !flag.message.includes(suppression.command)) return false;
    if (suppression.path && !flag.message.includes(suppression.path)) return false;
    return Boolean(suppression.category || suppression.command || suppression.path);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
