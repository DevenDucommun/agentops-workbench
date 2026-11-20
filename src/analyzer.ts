import type { AgentOpsConfig, RiskSuppression } from "./config";
import { defaultConfig } from "./config";
import type { CommandRecord } from "./types";
import type { Store } from "./store";
import { type EvidenceClaimId, commandOutcome, evidenceClaimRules, getClaimsLedger, isVerificationCommand } from "./ledger";
import { detectStalls } from "./stalls";
import { getCommands, getEvents, getFileChanges, getSession } from "./store";

export type RiskFlag = {
  eventId: number | null;
  severity: "low" | "medium" | "high";
  category: string;
  message: string;
};

export type { EvidenceClaimId } from "./ledger";
export { isVerificationCommand } from "./ledger";

/** The command-matched claim kinds that `evaluateEvidenceClaims` reports. */
export type CommandClaimId = Extract<EvidenceClaimId, "test" | "lint" | "typecheck" | "build">;

export type EvidenceClaimEvaluation = {
  id: CommandClaimId;
  category: string;
  label: string;
  claimed: boolean;
  supported: boolean;
  matchingCommand: string | null;
};

const destructiveCommandPattern = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+clean\s+-fd|drop\s+database|truncate\s+table|mkfs|chmod\s+-R\s+777|sudo\s+rm)\b/i;
const permissionCommandPattern = /\b(chmod|chown|setfacl)\b/i;
const secretPattern = /\b(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----)\b/;
const credentialRedactionPattern = /\[REDACTED:(aws-access-key|openai-style-key|github-token|slack-token|private-key)\]/;
const privacyRedactionPattern = /\[REDACTED:(email|local-path)\]/;

export function analyzeSession(store: Store, sessionId: string, config: AgentOpsConfig = defaultConfig): void {
  const flags = evaluateSessionRisks(store, sessionId, config);
  const db = store.db;
  const insert = db.query(`
    INSERT INTO risk_flags (session_id, event_id, severity, category, message)
    VALUES ($sessionId, $eventId, $severity, $category, $message)
  `);
  db.transaction(() => {
    db.query("DELETE FROM risk_flags WHERE session_id = $sessionId").run({ $sessionId: sessionId });
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

export function evaluateSessionRisks(store: Store, sessionId: string, config: AgentOpsConfig): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const commands = getCommands(store, sessionId);
  const fileChanges = getFileChanges(store, sessionId);
  const events = getEvents(store, sessionId);
  const session = getSession(store, sessionId);

  if (session?.source_adapter === "forensic-text") {
    flags.push({
      eventId: null,
      severity: "low",
      category: "forensic-import",
      message: "Plain-text forensic import uses inferred evidence. Prefer agentops run or provider JSONL for full-fidelity audit."
    });
    if (commands.length === 0) {
      flags.push({
        eventId: null,
        severity: "medium",
        category: "weak-forensic-transcript",
        message: "Plain-text transcript did not include observable shell commands, so command and verification evidence is missing."
      });
    }
  }

  for (const command of commands) {
    // A risky command that was denied or declined never ran (spec R2.4): it is
    // an informational blocked attempt unless risk.treatBlockedAsExecuted is set.
    // One blocked attempt per command, even when it matches both rules, so
    // gates.maxBlockedAttempts counts denied commands rather than flags.
    const blocked = isBlockedCommandStatus(command.status) && !config.risk.treatBlockedAsExecuted;
    const destructive = destructiveCommandPattern.test(command.command);
    const permission = permissionCommandPattern.test(command.command);
    if (blocked && (destructive || permission)) {
      const kind = destructive && permission ? "Destructive, permission-changing" : destructive ? "Destructive" : "Permission-changing";
      flags.push({ eventId: command.eventId, severity: "low", category: "blocked-attempt", message: `${kind} command was ${command.status} and did not run: ${command.command}` });
    } else {
      if (destructive) flags.push({ eventId: command.eventId, severity: "high", category: "destructive-command", message: `Destructive command detected: ${command.command}` });
      if (permission) flags.push({ eventId: command.eventId, severity: "medium", category: "permission-change", message: `Permission-changing command detected: ${command.command}` });
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

  // Retry and stall rules (spec R2.3).
  flags.push(...detectStalls(commands, fileChanges, { repeatedEditThreshold: config.risk.repeatedEditThreshold }));

  // Inferred commands were only mentioned in text; denied/declined ones never ran.
  const observedCommands = successfulCommands(commands, session?.source_adapter);
  const inferredVerificationCommands = commands.filter((command) => command.status === "inferred" && isVerificationCommand(command.command, config));
  for (const command of inferredVerificationCommands) {
    flags.push({
      eventId: command.eventId,
      severity: "medium",
      category: "inferred-verification-evidence",
      message: `Verification command was inferred from plain text, not observed: ${command.command}`
    });
  }

  const ranVerification = observedCommands.some((command) => isVerificationCommand(command.command, config));
  const finalEvent = [...events].reverse().find((event) => event.type === "final_response");
  if (finalEvent) {
    // Verification claims get a ledger verdict (spec R2.1, R2.2).
    const ledger = getClaimsLedger(store, sessionId, config);
    for (const claim of ledger.claims) {
      if (claim.verdict === "unsupported") {
        flags.push({
          eventId: finalEvent.id,
          severity: "medium",
          category: claim.category,
          message: evidenceClaimRules.find((rule) => rule.id === claim.id)?.unsupportedMessage ?? `Final response claims ${claim.claimText}, but no matching run was recorded.`
        });
      } else if (claim.verdict === "contradicted" && claim.cited) {
        const exit = claim.cited.exitCode === null ? "" : ` (exit ${claim.cited.exitCode})`;
        flags.push({
          eventId: finalEvent.id,
          severity: "medium",
          category: "contradicted-claim",
          message: `Final response claims ${claim.claimText}, but the latest ${claim.label} run failed: ${claim.cited.command}${exit}.`
        });
      }
    }
    const unsupportedEvidenceClaims = ledger.claims.filter((claim) => claim.verdict !== "supported");
    if (claimsSuccess(finalEvent.summary) && !ranVerification && unsupportedEvidenceClaims.length === 0) {
      flags.push({
        eventId: finalEvent.id,
        severity: "medium",
        category: "unsupported-success-claim",
        message: "Final response claims success, but no test/lint/check command was recorded."
      });
    }
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

  return flags.filter((flag) => !isSuppressed(flag, config.suppressions));
}

// Explicit per-command requirements use the latest recorded result for that exact command.
export function successfulCommands(commands: CommandRecord[], adapter: string | null | undefined): CommandRecord[] {
  const latest = new Map<string, CommandRecord>();
  for (const command of commands) {
    if (commandOutcome(command, adapter)) latest.set(command.command, command);
  }
  return [...latest.values()].filter((command) => commandOutcome(command, adapter) === "passed");
}

/** Denied (by a permission rule or the user) or declined (by the agent runtime's approval policy). */
export function isBlockedCommandStatus(status: string | null | undefined): boolean {
  return status === "denied" || status === "declined";
}

/** Command-matched claims only (test/lint/typecheck/build), as the dashboard shows them; the ledger covers all claims. */
export function evaluateEvidenceClaims(value: string, commands: string[]): EvidenceClaimEvaluation[] {
  return evidenceClaimRules.flatMap((rule) => {
    const pattern = rule.commandPattern;
    if (!pattern || rule.toolPattern || rule.afterLastEdit) return [];
    const matchingCommand = commands.find((command) => pattern.test(command)) ?? null;
    return {
      id: rule.id as CommandClaimId,
      category: rule.category,
      label: rule.label,
      claimed: rule.claimPattern.test(value),
      supported: matchingCommand !== null,
      matchingCommand
    };
  });
}

export function claimsFinalSuccess(value: string): boolean {
  return claimsSuccess(value);
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
