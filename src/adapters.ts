import { readFileSync } from "node:fs";
import type { AgentOpsConfig } from "./config";
import { parseClaudeCodeStreamJsonl } from "./claudeStream";
import { parseCodexExecJsonl } from "./codexExec";
import { detectForensicText, parseForensicTextTranscript } from "./forensicText";
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
  artifactHint: string;
  detect(input: AdapterInput): AdapterDetection;
  parse(input: AdapterInput, config: AgentOpsConfig): ParsedTranscript;
};

export const agentOpsJsonlAdapter: Adapter = {
  id: "agentops-jsonl",
  displayName: "AgentOps JSONL",
  artifactHint: "Canonical agentops.event.v1 JSONL (any source: claude-code, codex, pai, ...)",
  detect(input) {
    const first = firstJsonRecord(input.content);
    if (first?.schemaVersion === "agentops.event.v1") {
      if (typeof first.source === "string") {
        return { matched: true, confidence: 1, reason: `found agentops.event.v1 schemaVersion with source=${first.source}` };
      }
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

export const codexExecJsonlAdapter: Adapter = {
  id: "codex-exec-jsonl",
  displayName: "Codex Exec JSONL",
  artifactHint: "Native codex exec --json JSONL stream",
  detect(input) {
    const first = firstJsonRecord(input.content);
    if (first?.type === "thread.started" && typeof first.thread_id === "string") {
      return { matched: true, confidence: 1, reason: "found Codex thread.started event" };
    }
    if (first?.type === "turn.started" || first?.type === "item.completed" || first?.type === "item.started") {
      return { matched: true, confidence: 0.65, reason: "found Codex exec event stream shape" };
    }
    return { matched: false, confidence: 0, reason: "no Codex exec event stream markers found" };
  },
  parse(input, config) {
    return parseCodexExecJsonl(input.sourcePath, input.content, config);
  }
};

export const claudeCodeStreamJsonlAdapter: Adapter = {
  id: "claude-code-stream-json",
  displayName: "Claude Code Stream JSON",
  artifactHint: "Native claude -p --output-format stream-json JSONL stream",
  detect(input) {
    const first = firstJsonRecord(input.content);
    if (first?.type === "system" && first?.subtype === "init" && typeof first.session_id === "string") {
      return { matched: true, confidence: 1, reason: "found Claude Code stream init event" };
    }
    if (first?.type === "system" && typeof first.session_id === "string") {
      return { matched: true, confidence: 0.75, reason: "found Claude Code stream system event" };
    }
    if (
      typeof first?.session_id === "string" &&
      (first?.type === "assistant" || first?.type === "user" || first?.type === "result")
    ) {
      return { matched: true, confidence: 0.7, reason: "found Claude Code stream message shape" };
    }
    return { matched: false, confidence: 0, reason: "no Claude Code stream-json markers found" };
  },
  parse(input, config) {
    return parseClaudeCodeStreamJsonl(input.sourcePath, input.content, config);
  }
};

export const forensicTextAdapter: Adapter = {
  id: "forensic-text",
  displayName: "Forensic Plain Text",
  artifactHint: "Best-effort terminal transcript or copied coding-agent text",
  detect(input) {
    return detectForensicText(input.content, input.sourcePath);
  },
  parse(input, config) {
    return parseForensicTextTranscript(input.sourcePath, input.content, config);
  }
};

export const adapters = [
  codexExecJsonlAdapter,
  claudeCodeStreamJsonlAdapter,
  agentOpsJsonlAdapter,
  forensicTextAdapter
];

export function detectAdapters(input: AdapterInput): Array<{ adapter: Adapter; detection: AdapterDetection }> {
  return adapters
    .map((adapter) => ({ adapter, detection: adapter.detect(input) }))
    .sort((a, b) => b.detection.confidence - a.detection.confidence);
}

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

  const detected = detectAdapters(input)
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
