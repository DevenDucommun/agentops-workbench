import { type CommandContext, isShellExecution } from "./ledger";
import type { CommandRecord, FileChangeRecord } from "./types";

// Retry and stall rules (forensic recorder spec R2.3). Both are review signals,
// not failures: they never raise high-severity flags or touch the claim gate.
// The third R2.3 case, a failing test never re-run before a success claim, is
// the ledger's `contradicted` verdict (`contradicted-claim`).

export type StallFlag = {
  eventId: number | null;
  severity: "low" | "medium";
  category: "retry-without-change" | "repeated-edits";
  message: string;
};

// Rows that are not a finished run: never executed, only started, or with no recorded result.
const NO_OUTCOME = new Set(["inferred", "denied", "declined", "started", "in_progress", "running", "pending", "queued", "no_result"]);
const START_STATUSES = new Set(["started", "in_progress", "running"]);
const FAILED_STATUSES = new Set(["failed", "error", "timed_out", "timeout"]);

/**
 * `retry-without-change`: the same shell command started again after an earlier
 * run of it failed, with no file change in between. One flag per command; medium
 * once it was retried twice. A run counts only with a recorded outcome, and a
 * rerun that started before the failure's result arrived (parallel calls) is not
 * a retry.
 * `repeated-edits`: one file changed at least `repeatedEditThreshold` times.
 * File changes are applied changes only: ingest skips the start half of a
 * start/completion pair and failed or denied attempts (for Claude Code, an
 * edit whose linked result is an error).
 */
export function detectStalls(
  commands: CommandRecord[],
  fileChanges: FileChangeRecord[],
  options: { repeatedEditThreshold: number },
  context?: CommandContext
): StallFlag[] {
  const flags: StallFlag[] = [];
  const editRows = fileChanges.map((file) => file.eventId).filter((id): id is number => id !== null);

  const shell = commands
    .filter((command) => !context || command.eventId === null || isShellExecution(context.eventTypes.get(command.eventId), context.toolNames.get(command.eventId)))
    .sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0) || a.id - b.id);
  // A run starts at its own row, or at the open start row of the same command
  // (Codex records item.started and item.completed as separate rows). Its outcome
  // is known at its linked result (Claude Code) or at its own row.
  const openStarts = new Map<string, Array<number | null>>();
  const runs: Array<{ run: CommandRecord; key: string; start: number | null; outcome: number | null }> = [];
  for (const command of shell) {
    const key = normalizeCommand(command.command);
    const status = (command.status ?? "").toLowerCase();
    if (START_STATUSES.has(status) && command.exitCode === null) {
      openStarts.set(key, [...(openStarts.get(key) ?? []), command.eventId]);
      continue;
    }
    if (NO_OUTCOME.has(status) && command.exitCode === null) continue;
    const pending = openStarts.get(key) ?? [];
    const start = pending.length > 0 ? (pending.shift() ?? null) : command.eventId;
    const outcome = command.eventId === null ? null : (context?.resultRowIds.get(command.eventId) ?? command.eventId);
    runs.push({ run: command, key, start, outcome });
  }

  const retries = new Map<string, { command: string; count: number; firstEventId: number | null }>();
  const lastRun = new Map<string, (typeof runs)[number]>();
  for (const current of runs) {
    const previous = lastRun.get(current.key);
    if (previous && failed(previous.run) && startedAfter(current.start, previous.outcome) && !editedBetween(editRows, previous.outcome, current.start)) {
      const entry = retries.get(current.key) ?? { command: current.key, count: 0, firstEventId: current.run.eventId };
      entry.count += 1;
      retries.set(current.key, entry);
    }
    lastRun.set(current.key, current);
  }
  for (const { command, count, firstEventId } of retries.values()) {
    flags.push({
      eventId: firstEventId,
      severity: count >= 2 ? "medium" : "low",
      category: "retry-without-change",
      message: `Command re-run ${count} time${count === 1 ? "" : "s"} after failing, with no file change in between: ${command}`
    });
  }

  const edits = new Map<string, { count: number; firstEventId: number | null }>();
  for (const file of fileChanges) {
    const entry = edits.get(file.path) ?? { count: 0, firstEventId: file.eventId };
    entry.count += 1;
    if (entry.firstEventId === null || (file.eventId !== null && file.eventId < entry.firstEventId)) entry.firstEventId = file.eventId;
    edits.set(file.path, entry);
  }
  for (const [path, { count, firstEventId }] of [...edits].sort(([a], [b]) => a.localeCompare(b))) {
    if (count < options.repeatedEditThreshold) continue;
    flags.push({
      eventId: firstEventId,
      severity: "medium",
      category: "repeated-edits",
      message: `${path} was changed ${count} times in one session (threshold ${options.repeatedEditThreshold}).`
    });
  }
  return flags;
}

/**
 * Collapses spaces and tabs between arguments, never inside quotes or after a
 * backslash: `"a  b"` and `"a b"` are different paths, and an escaped quote does
 * not end a quoted argument. A newline separates commands, so it stays a newline.
 */
export function normalizeCommand(command: string): string {
  let out = "";
  let quote: string | null = null;
  let pending = "";
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (char === "\n" || char === "\r") pending = "\n";
      else if (pending === "") pending = " ";
      continue;
    }
    out += pending;
    pending = "";
    if (char === "\\" && quote !== "'") escaped = true;
    else if (quote === null && (char === '"' || char === "'")) quote = char;
    else if (char === quote) quote = null;
    out += char;
  }
  return out;
}

function failed(run: CommandRecord): boolean {
  if (typeof run.exitCode === "number") return run.exitCode !== 0;
  return FAILED_STATUSES.has((run.status ?? "").toLowerCase());
}

/** True when a run started after an earlier run's outcome. Rows that cannot be ordered count as later. */
function startedAfter(start: number | null, outcome: number | null): boolean {
  return start === null || outcome === null || start > outcome;
}

/** True when a file change sits between two runs. Runs without event rows cannot be ordered, so they count as separated. */
function editedBetween(editRows: number[], from: number | null, to: number | null): boolean {
  if (from === null || to === null) return true;
  return editRows.some((row) => row > from && row < to);
}
