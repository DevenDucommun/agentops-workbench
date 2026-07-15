import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AgentOpsConfig = {
  schemaVersion: "agentops.config.v1";
  privacy: {
    storeRawPayload: boolean;
    hashRawPayload: boolean;
    redactBeforeStore: boolean;
  };
  risk: {
    largeChurnLines: number;
    sensitivePaths: string[];
    productionPathPatterns: string[];
  };
  evidence: {
    verificationCommands: string[];
  };
  gates: {
    requireVerification: boolean;
    requiredVerificationCommands: string[];
    maxHighSeverityRisks: number;
    allowUnsupportedFinalClaims: boolean;
    maxGeneratedFileChurnLines: number;
    generatedFilePatterns: string[];
  };
  suppressions: RiskSuppression[];
};

export type RiskSuppression = {
  category?: string;
  path?: string;
  command?: string;
  reason?: string;
};

export type ConfigValidationResult = {
  path: string;
  exists: boolean;
  config: AgentOpsConfig;
  errors: string[];
  warnings: string[];
};

export const defaultConfig: AgentOpsConfig = {
  schemaVersion: "agentops.config.v1",
  privacy: {
    storeRawPayload: false,
    hashRawPayload: true,
    redactBeforeStore: true
  },
  risk: {
    largeChurnLines: 500,
    sensitivePaths: [".env", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", "secrets.json", "secrets.yaml", "credentials"],
    productionPathPatterns: ["prod", "production", "terraform", "helm", "k8s", "kubernetes", "deploy", "release"]
  },
  evidence: {
    verificationCommands: ["test", "check", "lint", "typecheck", "verify", "build"]
  },
  gates: {
    requireVerification: true,
    requiredVerificationCommands: [],
    maxHighSeverityRisks: 0,
    allowUnsupportedFinalClaims: false,
    maxGeneratedFileChurnLines: 0,
    generatedFilePatterns: ["generated", "dist", "build"]
  },
  suppressions: []
};

export function loadConfig(path = "agentops.config.json"): AgentOpsConfig {
  const result = validateConfigFile(path);
  if (result.errors.length) {
    throw new Error(formatConfigValidationResult(result));
  }
  return result.config;
}

export function validateConfigFile(path = "agentops.config.json"): ConfigValidationResult {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return {
      path: resolved,
      exists: false,
      config: defaultConfig,
      errors: [],
      warnings: ["Config file not found; defaults will be used."]
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      path: resolved,
      exists: true,
      config: defaultConfig,
      errors: [`Config file is not valid JSON: ${reason}`],
      warnings: []
    };
  }

  const errors = validateConfigShape(parsed);
  const normalized = normalizeConfig(parsed);
  errors.push(...validateConfigGuardrails(normalized));

  return {
    path: resolved,
    exists: true,
    config: normalized,
    errors,
    warnings: []
  };
}

export function formatConfigValidationResult(result: ConfigValidationResult): string {
  const lines = [result.errors.length ? `Invalid AgentOps config: ${result.path}` : `AgentOps config OK: ${result.path}`];
  if (!result.exists) lines.push("Using built-in defaults.");
  for (const error of result.errors) lines.push(`- ${error}`);
  for (const warning of result.warnings) lines.push(`- ${warning}`);
  return `${lines.join("\n")}\n`;
}

function normalizeConfig(value: unknown): AgentOpsConfig {
  const parsed = isRecord(value) ? (value as Partial<AgentOpsConfig>) : {};
  return {
    schemaVersion: "agentops.config.v1",
    privacy: {
      ...defaultConfig.privacy,
      ...(isRecord(parsed.privacy) ? parsed.privacy : {})
    },
    risk: {
      ...defaultConfig.risk,
      ...(isRecord(parsed.risk) ? parsed.risk : {})
    },
    evidence: {
      ...defaultConfig.evidence,
      ...(isRecord(parsed.evidence) ? parsed.evidence : {})
    },
    gates: {
      ...defaultConfig.gates,
      ...(isRecord(parsed.gates) ? parsed.gates : {})
    },
    suppressions: normalizeSuppressions(parsed.suppressions)
  };
}

function validateConfigShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["Config root must be a JSON object."];

  if (value.schemaVersion !== undefined && value.schemaVersion !== "agentops.config.v1") {
    errors.push(`Unsupported config schemaVersion: ${String(value.schemaVersion)}`);
  }

  if (value.privacy !== undefined) {
    if (!isRecord(value.privacy)) {
      errors.push("privacy must be an object.");
    } else {
      requireBoolean(value.privacy, "privacy.storeRawPayload", "storeRawPayload", errors);
      requireBoolean(value.privacy, "privacy.hashRawPayload", "hashRawPayload", errors);
      requireBoolean(value.privacy, "privacy.redactBeforeStore", "redactBeforeStore", errors);
    }
  }

  if (value.risk !== undefined) {
    if (!isRecord(value.risk)) {
      errors.push("risk must be an object.");
    } else {
      const largeChurnLines = value.risk.largeChurnLines;
      if (largeChurnLines !== undefined && (typeof largeChurnLines !== "number" || !Number.isInteger(largeChurnLines) || largeChurnLines < 1)) {
        errors.push("risk.largeChurnLines must be a positive integer.");
      }
      requireStringArray(value.risk, "risk.sensitivePaths", "sensitivePaths", errors);
      requireStringArray(value.risk, "risk.productionPathPatterns", "productionPathPatterns", errors);
    }
  }

  if (value.evidence !== undefined) {
    if (!isRecord(value.evidence)) {
      errors.push("evidence must be an object.");
    } else {
      requireStringArray(value.evidence, "evidence.verificationCommands", "verificationCommands", errors);
    }
  }

  if (value.gates !== undefined) {
    if (!isRecord(value.gates)) {
      errors.push("gates must be an object.");
    } else {
      requireBoolean(value.gates, "gates.requireVerification", "requireVerification", errors);
      requireBoolean(value.gates, "gates.allowUnsupportedFinalClaims", "allowUnsupportedFinalClaims", errors);
      requireNonNegativeInteger(value.gates, "gates.maxHighSeverityRisks", "maxHighSeverityRisks", errors);
      requireNonNegativeInteger(value.gates, "gates.maxGeneratedFileChurnLines", "maxGeneratedFileChurnLines", errors);
      requireStringArray(value.gates, "gates.requiredVerificationCommands", "requiredVerificationCommands", errors);
      requireStringArray(value.gates, "gates.generatedFilePatterns", "generatedFilePatterns", errors);
    }
  }

  if (value.suppressions !== undefined) {
    if (!Array.isArray(value.suppressions)) {
      errors.push("suppressions must be an array.");
    } else {
      value.suppressions.forEach((item, index) => {
        validateSuppressionShape(item, index, errors);
      });
    }
  }

  return errors;
}

function validateConfigGuardrails(config: AgentOpsConfig): string[] {
  const errors: string[] = [];
  if (config.privacy.storeRawPayload && !config.privacy.redactBeforeStore) {
    errors.push("privacy.storeRawPayload requires privacy.redactBeforeStore to remain true.");
  }
  if (config.privacy.storeRawPayload && !config.privacy.hashRawPayload) {
    errors.push("privacy.storeRawPayload requires privacy.hashRawPayload to remain true.");
  }
  return errors;
}

function validateSuppressionShape(value: unknown, index: number, errors: string[]): void {
  const prefix = `suppressions[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object.`);
    return;
  }

  const hasCategory = isNonEmptyString(value.category);
  const hasPath = isNonEmptyString(value.path);
  const hasCommand = isNonEmptyString(value.command);
  if (!hasCategory && !hasPath && !hasCommand) {
    errors.push(`${prefix} must include at least one of category, path, or command.`);
  }
  if (!isNonEmptyString(value.reason)) {
    errors.push(`${prefix}.reason is required for reviewability.`);
  }
  for (const key of ["category", "path", "command", "reason"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      errors.push(`${prefix}.${key} must be a string.`);
    }
  }
}

function normalizeSuppressions(value: unknown): RiskSuppression[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RiskSuppression => isRecord(item));
}

function requireBoolean(record: Record<string, unknown>, label: string, key: string, errors: string[]): void {
  if (record[key] !== undefined && typeof record[key] !== "boolean") {
    errors.push(`${label} must be a boolean.`);
  }
}

function requireNonNegativeInteger(record: Record<string, unknown>, label: string, key: string, errors: string[]): void {
  if (record[key] !== undefined && (typeof record[key] !== "number" || !Number.isInteger(record[key]) || record[key] < 0)) {
    errors.push(`${label} must be a non-negative integer.`);
  }
}

function requireStringArray(record: Record<string, unknown>, label: string, key: string, errors: string[]): void {
  if (record[key] === undefined) return;
  if (!Array.isArray(record[key]) || !(record[key] as unknown[]).every(isNonEmptyString)) {
    errors.push(`${label} must be an array of non-empty strings.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
