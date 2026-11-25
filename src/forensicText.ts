import { extname, resolve } from "node:path";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import { fallbackSessionId } from "./parser";
import { redactValue } from "./redaction";
import type { ParsedTranscript, RawEvent } from "./types";

type ForensicCommand = {
  event: RawEvent;
  lineNumber: number;
};

const forensicAdapterId = "forensic-text";
const commandStarts = [
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "pytest",
  "cargo",
  "go",
  "make",
  "gmake",
  "mvn",
  "gradle",
  "git",
  "rg",
  "grep",
  "sed",
  "awk",
  "ls",
  "cat",
  "deno",
  "tsc",
  "eslint",
  "biome",
  "turbo"
];

export function detectForensicText(content: string, sourcePath = ""): { matched: boolean; confidence: number; reason: string } {
  const text = content.trim();
  if (!text) return { matched: false, confidence: 0, reason: "empty artifact" };
  if (/^[{[]/.test(text)) return { matched: false, confidence: 0, reason: "artifact looks like structured JSON, not plain text" };

  const signals = scoreSignals(text);
  const extension = extname(sourcePath).toLowerCase();
  const textExtension = [".txt", ".log", ".md", ".transcript"].includes(extension);
  if (signals.observedCommandCount > 0 || signals.inferredCommandCount > 0 || signals.fileCount > 0 || signals.providerCount > 0) {
    return {
      matched: true,
      confidence: Math.min(
        0.75,
        0.35 + signals.observedCommandCount * 0.15 + signals.inferredCommandCount * 0.1 + signals.fileCount * 0.08 + signals.providerCount * 0.08
      ),
      reason: formatDetectionReason(signals)
    };
  }
  if (textExtension) {
    return {
      matched: true,
      confidence: 0.25,
      reason: "plain text artifact; import will be low-confidence if no commands are present"
    };
  }
  return { matched: false, confidence: 0, reason: "no plain-text transcript markers found" };
}

export function parseForensicTextTranscript(
  sourcePath: string,
  input: string,
  config: AgentOpsConfig = defaultConfig
): ParsedTranscript {
  const lines = input.split(/\r?\n/);
  const meaningfulLines = lines.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 })).filter((entry) => entry.line.length > 0);
  if (meaningfulLines.length === 0) {
    throw new Error("Plain-text transcript is empty. Import a saved terminal log or a provider JSONL artifact.");
  }

  const resolvedPath = resolve(sourcePath);
  const fallbackId = fallbackSessionId(sourcePath, input, "forensic-session");
  const events: RawEvent[] = [
    forensicNote(
      "Forensic plain-text import: evidence is lower-fidelity than provider JSONL. Commands from shell prompts are observed; commands and file changes from narrative text are inferred."
    )
  ];
  const commandEvents: ForensicCommand[] = [];
  const seenCommands = new Set<string>();
  const seenFiles = new Set<string>();

  for (const entry of meaningfulLines) {
    const exitCode = extractExitCode(entry.line);
    if (exitCode !== null) {
      // An exit code belongs to the most recent command, and only if that command
      // has none yet; never to an earlier command past a newer prompt.
      const previous = commandEvents.at(-1);
      if (previous && entry.lineNumber - previous.lineNumber <= 8 && previous.event.exitCode === undefined) {
        previous.event.exitCode = exitCode;
        previous.event.status = previous.event.status === "inferred" ? "inferred" : "observed";
      }
      continue;
    }

    const observedCommand = extractObservedCommand(entry.line);
    const inferredCommand = observedCommand ? null : extractInferredCommand(entry.line);
    const command = observedCommand ?? inferredCommand;
    // Every shell prompt line is a separate execution, so observed commands are
    // never merged. A command only mentioned in prose is recorded once, and not
    // at all when it was also observed.
    if (command && (observedCommand || !seenCommands.has(command))) {
      seenCommands.add(command);
      const event: RawEvent = {
        schemaVersion: "agentops.event.v1",
        type: "tool_call",
        source: "forensic-text",
        toolName: "shell",
        command,
        status: observedCommand ? "observed" : "inferred",
        summary: `${observedCommand ? "Observed" : "Inferred"} shell command from plain text: ${command}`,
        provenance: observedCommand ? "observed" : "inferred",
        confidence: observedCommand ? "medium" : "low",
        lineNumber: entry.lineNumber
      };
      commandEvents.push({ event, lineNumber: entry.lineNumber });
      events.push(event);
      continue;
    }

    for (const path of extractFilePaths(entry.line)) {
      const writeLike = /\b(add(?:ed)?|creat(?:ed|e)|edit(?:ed)?|modif(?:ied|y)|updat(?:ed|e)|wrote|write|patch(?:ed)?|chang(?:ed|e))\b/i.test(entry.line);
      const fileKey = `${writeLike ? "edit" : "read"}:${path}`;
      if (seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);
      events.push({
        schemaVersion: "agentops.event.v1",
        type: writeLike ? "file_edit" : "file_read",
        source: "forensic-text",
        path,
        operation: writeLike ? "inferred edit" : "inferred read",
        summary: `Inferred file ${writeLike ? "change" : "mention"} from plain text: ${path}`,
        provenance: "inferred",
        confidence: "low",
        lineNumber: entry.lineNumber
      });
    }
  }

  if (commandEvents.length === 0) {
    events.push(forensicNote("Low-confidence forensic import: no shell commands were observed in the plain-text transcript.", "missing"));
  }

  // Claims are read from every non-user line (evidence trust model, rule 4),
  // built independently of the bounded response: a later turn marker, or a
  // short unmarked last line, cannot hide a claim. The bounded response, when
  // one is found, is the summary people see; otherwise the last non-user line.
  const claimLines = nonUserLines(meaningfulLines);
  const finalResponse = extractFinalResponse(meaningfulLines) ?? claimLines.at(-1) ?? null;
  if (finalResponse) {
    const claimText = collapse(claimLines.join(" "));
    events.push({
      schemaVersion: "agentops.event.v1",
      type: "final_response",
      source: "forensic-text",
      role: "assistant",
      content: claimText.includes(finalResponse) ? claimText : collapse(`${claimText} ${finalResponse}`),
      summary: finalResponse,
      provenance: "inferred",
      confidence: commandEvents.length > 0 ? "low" : "very-low"
    });
  }

  const transcript: ParsedTranscript = {
    session: {
      type: "session",
      schemaVersion: "agentops.event.v1",
      id: fallbackId,
      agent: inferAgent(input),
      repo: undefined,
      task: "Forensic import from plain-text transcript",
      source: "forensic-text",
      sourcePath: resolvedPath,
      sourceAdapter: forensicAdapterId
    },
    events
  };

  return config.privacy.redactBeforeStore ? redactValue(transcript) : transcript;
}

function forensicNote(summary: string, status: "inferred" | "missing" = "inferred"): RawEvent {
  return {
    schemaVersion: "agentops.event.v1",
    type: "audit_note",
    source: "forensic-text",
    status,
    summary,
    provenance: status,
    confidence: status === "missing" ? "very-low" : "low"
  };
}

function scoreSignals(text: string): { observedCommandCount: number; inferredCommandCount: number; fileCount: number; providerCount: number } {
  const lines = text.split(/\r?\n/);
  return {
    observedCommandCount: lines.filter((line) => extractObservedCommand(line.trim())).length,
    inferredCommandCount: lines.filter((line) => !extractObservedCommand(line.trim()) && extractInferredCommand(line.trim())).length,
    fileCount: extractFilePaths(text).length,
    providerCount: /\b(Claude Code|Claude|Codex|OpenAI Codex)\b/i.test(text) ? 1 : 0
  };
}

function formatDetectionReason(signals: ReturnType<typeof scoreSignals>): string {
  const parts = [];
  if (signals.observedCommandCount > 0) parts.push(`${signals.observedCommandCount} observed command${signals.observedCommandCount === 1 ? "" : "s"}`);
  if (signals.inferredCommandCount > 0) parts.push(`${signals.inferredCommandCount} inferred command${signals.inferredCommandCount === 1 ? "" : "s"}`);
  if (signals.fileCount > 0) parts.push(`${signals.fileCount} file mention${signals.fileCount === 1 ? "" : "s"}`);
  if (signals.providerCount > 0) parts.push("provider marker");
  return `found forensic text markers: ${parts.join(", ")}`;
}

function extractObservedCommand(line: string): string | null {
  const prompt = line.match(/^\s*(?:\$|%|#)\s+(.+)$/);
  if (!prompt?.[1]) return null;
  const command = cleanCommand(prompt[1]);
  return looksLikeCommand(command) ? command : null;
}

function extractInferredCommand(line: string): string | null {
  const codeSpans = [...line.matchAll(/`([^`]+)`/g)].map((match) => cleanCommand(match[1] ?? ""));
  const codeCommand = codeSpans.find(looksLikeCommand);
  if (codeCommand) return codeCommand;

  const bashCall = line.match(/\b(?:Bash|exec_command)\s*\([^)]*(?:command|cmd)\s*[:=]\s*["']([^"']+)["']/i);
  if (bashCall?.[1]) return cleanCommand(bashCall[1]);

  const labeled = line.match(/\b(?:ran|running|run|command)\s*:?\s+(.+)$/i);
  if (labeled?.[1]) {
    const command = cleanCommand(labeled[1]);
    if (looksLikeCommand(command)) return command;
  }

  return null;
}

function cleanCommand(value: string): string {
  return value.replace(/^\s*>+\s*/, "").replace(/\s+#.*$/, "").trim();
}

function looksLikeCommand(value: string): boolean {
  const first = value.trim().split(/\s+/)[0]?.replace(/^\.\/?/, "") ?? "";
  return commandStarts.includes(first);
}

function extractExitCode(line: string): number | null {
  const match = line.match(/\b(?:exit(?:ed)?(?: code)?|Process exited with code)\s*:?\s*([0-9]{1,3})\b/i);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

function extractFilePaths(line: string): string[] {
  const matches = [...line.matchAll(/(?:`|")?((?:\.\/)?(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|rs|go|py|rb|java|kt|swift|css|html|sql|sh|zsh|bash|txt))(?:`|")?/g)];
  return matches
    .map((match) => (match[1] ?? "").replace(/^\.\//, ""))
    .filter((path) => path.length > 0 && !path.startsWith("http") && !path.includes(".."))
    .slice(0, 50);
}

/** A line that starts another speaker's turn in a pasted transcript. */
const TURN_MARKER = /^(?:user|human|you|me|system|assistant|claude|codex|agent|final|summary|result)\s*:/i;

function extractFinalResponse(lines: Array<{ line: string; lineNumber: number }>): string | null {
  const markerPattern = /^(?:final|assistant|summary|result)\s*:\s*/i;
  let markerIndex = -1;
  lines.forEach((entry, index) => {
    if (markerPattern.test(entry.line)) markerIndex = index;
  });
  if (markerIndex >= 0) {
    // The response runs from the marker to the next speaker turn or observed command,
    // so a claim on a continuation line is checked and a later user turn is not. Prose
    // that mentions an exit code is part of the response.
    const parts = [(lines[markerIndex]?.line ?? "").replace(markerPattern, "")];
    for (const entry of lines.slice(markerIndex + 1)) {
      if (TURN_MARKER.test(entry.line) || extractObservedCommand(entry.line)) break;
      parts.push(entry.line);
    }
    return collapse(parts.join(" ")) || null;
  }

  const candidates = lines
    .filter((entry) => !extractObservedCommand(entry.line) && !extractExitCode(entry.line))
    .map((entry) => entry.line)
    .filter((line) => line.length > 20);
  const tail = candidates.slice(-3).join(" ");
  return tail ? collapse(tail) : null;
}

/** A line that starts a user's turn. */
const USER_TURN = /^(?:user|human|you|me)\s*:/i;

/**
 * Every line outside a user turn except shell prompts (commands, not
 * statements). A line that mentions an exit code is kept: it may also carry a
 * claim ("Tests passed with exit code 0."). A user turn runs from its marker to
 * the next speaker turn or shell prompt.
 */
function nonUserLines(lines: Array<{ line: string; lineNumber: number }>): string[] {
  const parts: string[] = [];
  let inUserTurn = false;
  for (const entry of lines) {
    if (USER_TURN.test(entry.line)) inUserTurn = true;
    else if (TURN_MARKER.test(entry.line) || extractObservedCommand(entry.line)) inUserTurn = false;
    if (inUserTurn || extractObservedCommand(entry.line)) continue;
    parts.push(entry.line);
  }
  return parts;
}

function inferAgent(input: string): string {
  if (/\bClaude Code\b/i.test(input)) return "Claude Code";
  if (/\bClaude\b/i.test(input)) return "Claude";
  if (/\bCodex|OpenAI Codex\b/i.test(input)) return "Codex";
  return "Unknown";
}

/** Whitespace-collapsed but never clipped: claim checks read the whole final response. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
