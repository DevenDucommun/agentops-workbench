import { evaluateSessionRisks, type RiskFlag, successfulCommands, isVerificationCommand } from "./analyzer";
import type { AgentOpsConfig } from "./config";
import { commandOutcome, evidenceClaimRules } from "./ledger";
import { defaultConfig } from "./config";
import type { GitChange } from "./git";
import { getCommands, getFileChanges, getSession, type Store } from "./store";

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
  ...evidenceClaimRules.map((rule) => rule.category),
  "contradicted-claim",
  "inferred-verification-evidence"
]);

export function evaluateQualityGate(
  store: Store,
  sessionId: string,
  config: AgentOpsConfig = defaultConfig,
  options: { gitChanges?: GitChange[]; risks?: RiskFlag[] } = {}
): GateResult {
  const session = getSession(store, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const commands = getCommands(store, sessionId);
  const risks = options.risks ?? evaluateSessionRisks(store, sessionId, config);
  const files = getFileChanges(store, sessionId);
  const verification = successfulCommands(commands, session.source_adapter).filter((command) => isVerificationCommand(command.command, config));
  const checks: GateCheck[] = [];

  checks.push(checkAtMost("max-high-risks", "High-severity risks", risks.filter((risk) => risk.severity === "high").length, config.gates.maxHighSeverityRisks));
  // Blocked risky commands are informational one by one; repeated attempts fail the gate (spec R2.4).
  checks.push(checkAtMost("max-blocked-attempts", "Blocked risky attempts", risks.filter((risk) => risk.category === "blocked-attempt").length, config.gates.maxBlockedAttempts));

  if (config.gates.requireVerification) {
    const legacyClaude = session.source_adapter === "claude-code-stream-json"
      && commands.some((command) => command.status === "completed" && isVerificationCommand(command.command, config));
    const missingEvidence = legacyClaude
      ? "Re-import the original Claude stream to verify tool outcomes for this older session."
      : commands.some((command) => isVerificationCommand(command.command, config))
        ? "No successful verification command recorded."
        : "No observed verification command recorded.";
    checks.push({
      id: "required-verification",
      label: "Verification evidence",
      status: verification.length > 0 ? "passed" : "failed",
      message: verification.length > 0 ? `${verification.length} observed verification command${verification.length === 1 ? "" : "s"} recorded.` : missingEvidence,
      observed: verification.length,
      threshold: ">= 1"
    });

    // Use the ledger's test/lint/typecheck/build kinds. Custom verification commands
    // have no ledger kind and can recover on a retry of the same command.
    const failures = new Map<string, string>();
    for (const command of commands) {
      const outcome = commandOutcome(command, session.source_adapter);
      if (!outcome || !isVerificationCommand(command.command, config)) continue;
      const kinds = evidenceClaimRules.filter((rule) => !rule.toolPattern && rule.commandPattern?.test(command.command)).map((rule) => rule.id);
      for (const key of kinds.length ? kinds : [command.command]) {
        if (outcome === "failed") failures.set(key, command.command);
        else failures.delete(key);
      }
    }
    const failed = [...new Set(failures.values())];
    if (failed.length) {
      checks.push({
        ...checkAtMost("failed-verification", "Failed verification commands", failed.length, 0),
        message: `Latest attempt failed: ${failed.join(", ")}.`
      });
    }
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
    const unsupportedClaims = risks.filter((risk) => unsupportedClaimCategories.has(risk.category)).length;
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
