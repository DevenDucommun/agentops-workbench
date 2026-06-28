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
  suppressions: RiskSuppression[];
};

export type RiskSuppression = {
  category?: string;
  path?: string;
  command?: string;
  reason?: string;
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
  suppressions: []
};

export function loadConfig(path = "agentops.config.json"): AgentOpsConfig {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return defaultConfig;

  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<AgentOpsConfig>;
  if (parsed.schemaVersion && parsed.schemaVersion !== "agentops.config.v1") {
    throw new Error(`Unsupported config schemaVersion: ${parsed.schemaVersion}`);
  }

  return {
    schemaVersion: "agentops.config.v1",
    privacy: {
      ...defaultConfig.privacy,
      ...parsed.privacy
    },
    risk: {
      ...defaultConfig.risk,
      ...parsed.risk
    },
    evidence: {
      ...defaultConfig.evidence,
      ...parsed.evidence
    },
    suppressions: normalizeSuppressions(parsed.suppressions)
  };
}

function normalizeSuppressions(value: unknown): RiskSuppression[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RiskSuppression => item !== null && typeof item === "object");
}
