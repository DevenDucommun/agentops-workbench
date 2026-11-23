import type { AgentOpsConfig, RiskSuppression } from "./config";
import { defaultConfig } from "./config";
import type { Store } from "./store";
import type { CommandRecord } from "./types";
import { type ClaimsLedger, claimsRule, type EvidenceClaimId, evidenceClaimRules, getClaimsLedger, getCommandContext, hasRecordedOutcome, mentionsRuleCommand } from "./ledger";
import { detectStalls } from "./stalls";
import { getCommands, getEvents, getFileChanges, getSession, getUnconfirmedFileEvents } from "./store";

type RiskFlag = {
  eventId: number | null;
  severity: "low" | "medium" | "high";
  category: string;
  message: string;
};

export type { EvidenceClaimId } from "./ledger";

export type EvidenceClaimEvaluation = {
  id: EvidenceClaimId;
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
  const db = store.db;
  db.query("DELETE FROM risk_flags WHERE session_id = $sessionId").run({ $sessionId: sessionId });

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

  const context = getCommandContext(store, sessionId);
  const pairedStarts = startRowsWithOutcome(commands, context.invocationKeys);
  for (const command of commands) {
    // The start row of an invocation that also has an outcome row (Codex
    // item.started, then item.completed or a decline) is the same command, not
    // a second run: the outcome row alone decides its command risk. Its output
    // is still checked below.
    const pairedStart = pairedStarts.has(command.id);
    // A risky command that was denied or declined never ran (spec R2.4): it is
    // an informational blocked attempt unless risk.treatBlockedAsExecuted is set.
    // One blocked attempt per command, even when it matches both rules, so
    // gates.maxBlockedAttempts counts denied commands rather than flags.
    const blocked = isBlockedCommandStatus(command.status) && !config.risk.treatBlockedAsExecuted;
    const destructive = destructiveCommandPattern.test(command.command);
    const permission = permissionCommandPattern.test(command.command);
    if (pairedStart) {
      // No command flags for the start half.
    } else if (blocked && (destructive || permission)) {
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

  const unconfirmed = getUnconfirmedFileEvents(store, sessionId);
  const appliedChanges = fileChanges.filter(file => file.eventId !== null && !unconfirmed.has(file.eventId));
  flags.push(...detectStalls(commands, appliedChanges, { repeatedEditThreshold: config.risk.repeatedEditThreshold }, context));

  // An attempt without a recorded outcome cannot substantiate a success claim.
  const observedCommands = commands.filter(hasRecordedOutcome);
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
    flags.push(...ledgerClaimFlags(ledger, finalEvent.id));
    const unsupportedEvidenceClaims = ledger.claims.filter((claim) => claim.verdict !== "supported");
    if (claimsSuccess(finalClaimTexts(finalEvent)) && !ranVerification && unsupportedEvidenceClaims.length === 0) {
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

/**
 * The texts whose claims a final response makes: the full response and, unless the
 * two are identical, the stored summary too, so every claim shown as the Final Outcome
 * needs evidence. A summary derived from the response is stored as the full response
 * (see summarizeEvent), so only a producer's own summary adds claims. Older stores
 * have no `text`, so the summary alone is used.
 */
export function finalClaimTexts(event: { text?: string | null; summary: string }): string[] {
  const text = event.text?.trim() ? event.text : null;
  if (!text) return [event.summary];
  // Both are checked. A producer's summary is shown as the Final Outcome, so every claim
  // in it needs evidence; skipping a summary that "looks like" the body's opening let
  // unsupported claims through, and checking it at worst flags a claim twice.
  return normalizeClaimText(event.summary) === normalizeClaimText(text) ? [text] : [text, event.summary];
}

/** Whitespace-normalized for matching only, so a Markdown soft wrap inside a claim still matches. */
function normalizeClaimText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toClaimTexts(value: string | readonly string[]): string[] {
  return (typeof value === "string" ? [value] : [...value]).map(normalizeClaimText);
}

// Only the separate start row an adapter writes before the outcome row (Codex
// item.started, "in_progress"). A Claude Code "started" row is a background run
// that did execute, so it is never paired away.
const START_ROW_STATUSES = new Set(["in_progress"]);

/**
 * Row ids of start rows (started, in progress, no exit code) that a later row
 * of the same invocation completes. A start with no later outcome (an
 * interrupted run), or without an invocation id, is not paired: it may have run.
 */
export function startRowsWithOutcome(commands: CommandRecord[], invocationKeys: Map<number, string> = new Map()): Set<number> {
  const open = new Map<string, number[]>();
  const paired = new Set<number>();
  const ordered = [...commands].sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0) || a.id - b.id);
  // Only rows that name the same invocation pair. Rows without an invocation id
  // are never paired: matching by command text could pair an interrupted run
  // with a later, unrelated decline and clear its risk.
  for (const command of ordered) {
    const id = command.eventId === null ? undefined : invocationKeys.get(command.eventId);
    if (id === undefined) continue;
    // Same invocation id and same command: an id reused by another worker for a
    // different command never pairs.
    const invocation = `${id}\u0000${command.command}`;
    const isStart = START_ROW_STATUSES.has((command.status ?? "").toLowerCase()) && command.exitCode === null;
    if (isStart) {
      open.set(invocation, [...(open.get(invocation) ?? []), command.id]);
      continue;
    }
    const start = open.get(invocation)?.shift();
    if (start !== undefined) paired.add(start);
  }
  return paired;
}

/**
 * Blocked risky attempts, counted from the commands themselves so a store whose
 * flags predate the rule (or whose analysis was interrupted) still counts them:
 * one per denied or declined destructive or permission-changing command.
 */
/**
 * High-severity risks for the gate, with blocked commands judged under the
 * check's policy rather than the audit's: stored high flags on denied or
 * declined destructive commands are dropped, and under
 * risk.treatBlockedAsExecuted each such command counts once as a high
 * destructive-command risk unless a suppression in this config covers it.
 * Switching the policy between audit and check therefore gives the same result
 * as re-auditing.
 */
export function gateHighRiskCount(commands: CommandRecord[], risks: Array<{ eventId: number | null; severity: string; category: string }>, config: AgentOpsConfig = defaultConfig): number {
  const blocked = commands.filter((command) => isBlockedCommandStatus(command.status) && destructiveCommandPattern.test(command.command));
  const blockedEvents = new Set(blocked.map((command) => command.eventId).filter((id): id is number => id !== null));
  const stored = risks.filter((risk) => risk.severity === "high" && !(risk.category === "destructive-command" && risk.eventId !== null && blockedEvents.has(risk.eventId))).length;
  if (!config.risk.treatBlockedAsExecuted) return stored;
  const live = blocked
    .map((command): RiskFlag => ({ eventId: command.eventId, severity: "high", category: "destructive-command", message: `Destructive command detected: ${command.command}` }))
    .filter((flag) => !isSuppressed(flag, config.suppressions));
  return stored + live.length;
}

export function countBlockedAttempts(commands: CommandRecord[], config: AgentOpsConfig = defaultConfig): number {
  if (config.risk.treatBlockedAsExecuted) return 0;
  return commands.filter(
    (command) => isBlockedCommandStatus(command.status) && (destructiveCommandPattern.test(command.command) || permissionCommandPattern.test(command.command))
  ).length;
}

/** Denied (by a permission rule or the user) or declined (by the agent runtime's approval policy). */
export function isBlockedCommandStatus(status: string | null | undefined): boolean {
  return status === "denied" || status === "declined";
}

/**
 * The dashboard's per-kind evidence rows, matched as on v3.2: any command that
 * mentions the kind. The dashboard adds the ledger's supported verdicts on top
 * (configured support commands); strict support rules live in the ledger.
 */
export function evaluateEvidenceClaims(value: string | readonly string[], commands: string[]): EvidenceClaimEvaluation[] {
  const texts = toClaimTexts(value);
  return evidenceClaimRules.map((rule) => {
    const matchingCommand = commands.find((command) => mentionsRuleCommand(rule, command)) ?? null;
    return {
      id: rule.id,
      category: rule.category,
      label: rule.label,
      claimed: texts.some((text) => claimsRule(rule, text)),
      supported: matchingCommand !== null,
      matchingCommand
    };
  });
}

export function claimsFinalSuccess(value: string | readonly string[]): boolean {
  return claimsSuccess(value);
}

function claimsSuccess(value: string | readonly string[]): boolean {
  return toClaimTexts(value).some((text) => /\b(done|complete|completed|success|successful|fixed|implemented|passed|working)\b/i.test(text));
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

/** Risk flags for a ledger's unsupported and contradicted claims (spec R2.1, R2.2). */
export function ledgerClaimFlags(ledger: ClaimsLedger, finalEventId: number | null): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const claim of ledger.claims) {
    if (claim.verdict === "unsupported") {
      flags.push({
        eventId: finalEventId,
        severity: "medium",
        category: claim.category,
        message: `Final response claims ${claim.label} success, but no observed matching ${claim.label} command was recorded.`
      });
    } else if (claim.verdict === "contradicted" && claim.cited) {
      const exit = claim.cited.exitCode === null ? "" : ` (exit ${claim.cited.exitCode})`;
      flags.push({
        eventId: finalEventId,
        severity: "medium",
        category: "contradicted-claim",
        message: `Final response claims ${claim.label} success, but the latest ${claim.label} run failed: ${claim.cited.command}${exit}.`
      });
    }
  }
  return flags;
}

/** Categories that only ledger verdicts raise. */
export const LEDGER_CLAIM_CATEGORIES = new Set([...evidenceClaimRules.map((rule) => rule.category), "contradicted-claim"]);

/**
 * The ledger's claim flags for a stored session under `config`, after its
 * suppressions: what an audit with this config would store. The gate uses these
 * instead of the stored ones, so a check with a different config, or a store
 * whose analysis did not finish, still judges claims by the config it was given.
 */
export function currentLedgerClaimFlags(store: Store, sessionId: string, config: AgentOpsConfig): RiskFlag[] {
  const ledger = getClaimsLedger(store, sessionId, config);
  if (ledger.finalEventRowId === null) return [];
  return ledgerClaimFlags(ledger, ledger.finalEventRowId).filter((flag) => !isSuppressed(flag, config.suppressions));
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
