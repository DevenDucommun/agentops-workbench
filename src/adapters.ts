import { readFileSync } from "node:fs";
import type { AgentOpsConfig } from "./config";
import { parseJsonlTranscript } from "./parser";
import type { ParsedTranscript } from "./types";

export type AdapterInput = {
  sourcePath: string;
  content: string;
};

export type AdapterDetection = {
  matched: boolean;
  confidence: number;
  reason: string;
};

export type Adapter = {
  id: string;
  displayName: string;
  detect(input: AdapterInput): AdapterDetection;
  parse(input: AdapterInput, config: AgentOpsConfig): ParsedTranscript;
};

export const agentOpsJsonlAdapter: Adapter = {
  id: "agentops-jsonl",
  displayName: "AgentOps JSONL",
  detect(input) {
    const first = firstJsonRecord(input.content);
    if (first?.schemaVersion === "agentops.event.v1") {
      return { matched: true, confidence: 1, reason: "found agentops.event.v1 schemaVersion" };
    }
    if (first?.type === "session") {
      return { matched: true, confidence: 0.7, reason: "found JSONL session record" };
    }
    return { matched: false, confidence: 0, reason: "no session record found" };
  },
  parse(input, config) {
    return parseJsonlTranscript(input.sourcePath, input.content, {
      sourceAdapter: "agentops-jsonl",
      config
    });
  }
};

export const paiExportJsonlAdapter: Adapter = {
  id: "pai-export-jsonl",
  displayName: "PAI Export JSONL",
  detect(input) {
    const first = firstJsonRecord(input.content);
    if (first?.schemaVersion === "agentops.event.v1" && first?.source === "pai") {
      return { matched: true, confidence: 1, reason: "found PAI source metadata" };
    }
    if (first?.schemaVersion === "agentops.event.v1") {
      return { matched: true, confidence: 0.85, reason: "found AgentOps JSONL compatible schema" };
    }
    return { matched: false, confidence: 0, reason: "no PAI export metadata found" };
  },
  parse(input, config) {
    return parseJsonlTranscript(input.sourcePath, input.content, {
      sourceAdapter: "pai-export-jsonl",
      config
    });
  }
};

export const adapters = [paiExportJsonlAdapter, agentOpsJsonlAdapter];

export function loadAdapterInput(sourcePath: string): AdapterInput {
  return {
    sourcePath,
    content: readFileSync(sourcePath, "utf8")
  };
}

export function resolveAdapter(input: AdapterInput, adapterId?: string): Adapter {
  if (adapterId) {
    const adapter = adapters.find((candidate) => candidate.id === adapterId);
    if (!adapter) {
      throw new Error(`Unknown adapter: ${adapterId}. Available adapters: ${adapters.map((candidate) => candidate.id).join(", ")}`);
    }
    return adapter;
  }

  const detected = adapters
    .map((adapter) => ({ adapter, detection: adapter.detect(input) }))
    .filter((result) => result.detection.matched)
    .sort((a, b) => b.detection.confidence - a.detection.confidence);

  if (!detected[0]) {
    throw new Error("Could not detect an adapter for this artifact. Use --adapter <id> to select one explicitly.");
  }

  return detected[0].adapter;
}

function firstJsonRecord(input: string): Record<string, unknown> | null {
  const first = input.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) return null;
  try {
    const parsed = JSON.parse(first) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
