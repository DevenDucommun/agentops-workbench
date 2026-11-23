import { countBlockedAttempts, currentLedgerClaimFlags, gateHighRiskCount, isObservedExecution, isVerificationCommand, LEDGER_CLAIM_CATEGORIES } from "./analyzer";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import type { GitChange } from "./git";
import { getCommands, getFileChanges, getRiskFlags, getSession, type Store } from "./store";

export type GateStatus = "passed" | "failed";

export type GateCheck = {
  id: string;
  label: string;
  status: GateStatus;
  message: string;
  observed: number;
  threshold: number | string;
};

export type GateResult = {
  schemaVersion: "agentops.gate.v1";
  sessionId: string;
  status: GateStatus;
  summary: string;
  checks: GateCheck[];
  repo: {
    changedFiles: number;
  };
};

const unsupportedClaimCategories = new Set([
  "unsupported-success-claim",
  "missing-test-evidence",
  "missing-lint-evidence",
  "missing-typecheck-evidence",
  "missing-build-evidence",
  "contradicted-claim",
  "inferred-verification-evidence"
]);

export function evaluateQualityGate(
  store: Store,
  sessionId: string,
  config: AgentOpsConfig = defaultConfig,
  options: { gitChanges?: GitChange[] } = {}
): GateResult {
  // The whole decision reads one snapshot: a re-import committing mid-check can
  // never mix the old session's commands with the replacement's claims.
  return store.db.transaction(() => evaluateQualityGateSnapshot(store, sessionId, config, options))();
}

function evaluateQualityGateSnapshot(
  store: Store,
  sessionId: string,
  config: AgentOpsConfig,
  options: { gitChanges?: GitChange[] }
): GateResult {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const commands = getCommands(store, sessionId);
  const risks = getRiskFlags(store, sessionId);
  const files = getFileChanges(store, sessionId);
  const verification = commands.filter((command) => isObservedExecution(command) && isVerificationCommand(command.command, config));
  const checks: GateCheck[] = [];

  const highRisks = gateHighRiskCount(commands, risks, config);
  checks.push(checkAtMost("max-high-risks", "High-severity risks", highRisks, config.gates.maxHighSeverityRisks));
  // Blocked risky commands are informational one by one; repeated attempts fail the gate (spec R2.4).
  // Counted from the stored commands, not flags, so a store analyzed before this
  // rule existed (or an interrupted analysis) cannot hide them.
  checks.push(checkAtMost("max-blocked-attempts", "Blocked risky attempts", countBlockedAttempts(commands, config), config.gates.maxBlockedAttempts));

  if (config.gates.requireVerification) {
    checks.push({
      id: "required-verification",
      label: "Verification evidence",
      status: verification.length > 0 ? "passed" : "failed",
      message: verification.length > 0 ? `${verification.length} observed verification command${verification.length === 1 ? "" : "s"} recorded.` : "No observed verification command recorded.",
      observed: verification.length,
      threshold: ">= 1"
    });
  }

  for (const required of config.gates.requiredVerificationCommands) {
    const matched = verification.some((command) => command.command.toLowerCase().includes(required.toLowerCase()));
    checks.push({
      id: `required-command:${required}`,
      label: `Required command: ${required}`,
      status: matched ? "passed" : "failed",
      message: matched ? `Observed required verification command containing "${required}".` : `No observed verification command containing "${required}" was recorded.`,
      observed: matched ? 1 : 0,
      threshold: ">= 1"
    });
  }

  if (!config.gates.allowUnsupportedFinalClaims) {
    // Ledger verdicts are judged under this check's config (not the audit's), so a
    // stricter support list here, or an analysis that did not finish, cannot pass
    // a claim the ledger rejects. Other claim flags come from the stored analysis.
    const unsupportedClaims =
      risks.filter((risk) => unsupportedClaimCategories.has(risk.category) && !LEDGER_CLAIM_CATEGORIES.has(risk.category)).length +
      currentLedgerClaimFlags(store, sessionId, config).length;
    checks.push(checkAtMost("unsupported-final-claims", "Unsupported or inferred final claims", unsupportedClaims, 0));
  }

  const generatedChurn = files.filter((file) => isGeneratedPath(file.path, config.gates.generatedFilePatterns)).reduce((total, file) => total + (file.linesAdded ?? 0) + (file.linesRemoved ?? 0), 0);
  checks.push(checkAtMost("generated-file-churn", "Generated-file churn", generatedChurn, config.gates.maxGeneratedFileChurnLines));

  const failed = checks.filter((check) => check.status === "failed");
  return {
    schemaVersion: "agentops.gate.v1",
    sessionId,
    status: failed.length > 0 ? "failed" : "passed",
    summary: failed.length > 0 ? `${failed.length} quality gate${failed.length === 1 ? "" : "s"} failed.` : "All quality gates passed.",
    checks,
    repo: {
      changedFiles: options.gitChanges?.length ?? 0
    }
  };
}

export function formatGateText(result: GateResult): string {
  const lines = [
    "# AgentOps Quality Gate",
    "",
    `Status: ${result.status.toUpperCase()}`,
    `Session: ${result.sessionId}`,
    `Summary: ${result.summary}`,
    `Git Changed Files: ${result.repo.changedFiles}`,
    "",
    "## Checks",
    ...result.checks.map((check) => `- ${check.status === "passed" ? "PASS" : "FAIL"} ${check.label}: ${check.message}`)
  ];
  return `${lines.join("\n")}\n`;
}

export function formatGateGithub(result: GateResult): string {
  const icon = result.status === "passed" ? "PASS" : "FAIL";
  const rows = result.checks.map((check) => `| ${check.status === "passed" ? "PASS" : "FAIL"} | ${escapeTable(check.label)} | ${escapeTable(check.message)} |`);
  return [
    "## AgentOps Quality Gate",
    "",
    `**Status:** ${icon} ${result.status.toUpperCase()}`,
    "",
    `Session: \`${result.sessionId}\``,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "_Generated locally by AgentOps Workbench. This command does not post to GitHub._"
  ].join("\n") + "\n";
}

export function formatGateJson(result: GateResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function checkAtMost(id: string, label: string, observed: number, max: number): GateCheck {
  return {
    id,
    label,
    status: observed <= max ? "passed" : "failed",
    message: `${observed} observed; maximum allowed is ${max}.`,
    observed,
    threshold: `<= ${max}`
  };
}

function isGeneratedPath(path: string, patterns: string[]): boolean {
  const normalized = path.toLowerCase();
  return patterns.some((pattern) => pattern.trim() && normalized.includes(pattern.toLowerCase()));
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}
