import type { AgentOpsConfig, RiskSuppression } from "./config";
import { defaultConfig } from "./config";
import type { Store } from "./store";
import { getCommands, getEvents, getFileChanges, getSession } from "./store";

type RiskFlag = {
  eventId: number | null;
  severity: "low" | "medium" | "high";
  category: string;
  message: string;
};

type EvidenceClaimRule = {
  id: EvidenceClaimId;
  category: string;
  claimPattern: RegExp;
  commandPattern: RegExp;
  label: string;
};

export type EvidenceClaimId = "test" | "lint" | "typecheck" | "build";

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
const evidenceClaimRules: EvidenceClaimRule[] = [
  {
    id: "test",
    category: "missing-test-evidence",
    label: "test",
    claimPattern: /\b(test|tests|test suite|unit tests|integration tests)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|green|succeed(?:ed)?|successful|verified)\b|\b(pass(?:ed|es)?|passing|green)\b[\s\S]{0,80}\b(test|tests|test suite)\b/i,
    commandPattern: /\b(pytest|bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|cargo\s+test|go\s+test|make\s+test|gmake\s+test|mvn\s+test|gradle\s+test)\b/i
  },
  {
    id: "lint",
    category: "missing-lint-evidence",
    label: "lint",
    claimPattern: /\b(lint|linting|eslint)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified)\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(lint|linting|eslint)\b/i,
    commandPattern: /\b(eslint|bun\s+(?:run\s+)?lint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint|make\s+lint|gmake\s+lint)\b/i
  },
  {
    id: "typecheck",
    category: "missing-typecheck-evidence",
    label: "typecheck",
    claimPattern: /\b(typecheck|type check|type-check|type checking|tsc)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified)\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(typecheck|type check|type-check|type checking|tsc)\b/i,
    commandPattern: /\b(tsc|bun\s+(?:run\s+)?(?:typecheck|type-check)|npm\s+(?:run\s+)?(?:typecheck|type-check)|pnpm\s+(?:run\s+)?(?:typecheck|type-check)|yarn\s+(?:run\s+)?(?:typecheck|type-check)|make\s+(?:typecheck|type-check)|gmake\s+(?:typecheck|type-check))\b/i
  },
  {
    id: "build",
    category: "missing-build-evidence",
    label: "build",
    claimPattern: /\b(build|built|compile|compiled|compilation)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified|complete(?:d)?)\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(build|compile|compilation)\b/i,
    commandPattern: /\b(bun\s+(?:run\s+)?build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|cargo\s+build|go\s+build|make\s+build|gmake\s+build|mvn\s+(?:package|compile)|gradle\s+build)\b/i
  }
];

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
  if (finalEvent) {
    const unsupportedEvidenceClaims = findUnsupportedEvidenceClaims(finalEvent.summary, commands.map((command) => command.command));
    for (const claim of unsupportedEvidenceClaims) {
      flags.push({
        eventId: finalEvent.id,
        severity: "medium",
        category: claim.category,
        message: `Final response claims ${claim.label} success, but no matching ${claim.label} command was recorded.`
      });
    }
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

export function evaluateEvidenceClaims(value: string, commands: string[]): EvidenceClaimEvaluation[] {
  return evidenceClaimRules.map((rule) => {
    const matchingCommand = commands.find((command) => rule.commandPattern.test(command)) ?? null;
    return {
      id: rule.id,
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

function findUnsupportedEvidenceClaims(value: string, commands: string[]): EvidenceClaimRule[] {
  const unsupported = new Set(
    evaluateEvidenceClaims(value, commands)
      .filter((claim) => claim.claimed && !claim.supported)
      .map((claim) => claim.category)
  );
  return evidenceClaimRules.filter((rule) => unsupported.has(rule.category));
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
