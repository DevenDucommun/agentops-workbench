import { type CommandContext, commandOutcome, hasRecordedOutcome, isShellExecution } from "./ledger";
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

const START_STATUSES = new Set(["started", "in_progress", "running"]);

/**
 * `retry-without-change`: the same shell command started again after an earlier
 * run of it failed, with no file change in between. One flag per command; medium
 * once it was retried twice. Both runs need an executed status and a recorded
 * outcome (an exit code, or a failed or success status such as `timed_out` or
 * `completed`). The command is compared exactly, after trimming leading and
 * trailing whitespace. A rerun counts only if it started after the failure's
 * result was recorded. Hook invocation IDs identify a recorded start; other
 * start rows are matched in order and overlapping runs may be paired wrongly.
 * `repeated-edits`: one file changed at least `repeatedEditThreshold` times.
 * The caller supplies only applied file changes. The store keeps attempts for
 * session reports and existing gates, including sensitive-file checks.
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
    if (key.includes("[REDACTED:")) continue;
    const status = (command.status ?? "").toLowerCase();
    if (START_STATUSES.has(status) && command.exitCode === null) {
      openStarts.set(key, [...(openStarts.get(key) ?? []), command.eventId]);
      continue;
    }
    if (!hasRecordedOutcome(command)) continue;
    const pending = openStarts.get(key) ?? [];
    const linkedStart = command.eventId === null ? undefined : context?.hookStartRows.get(command.eventId);
    const start = linkedStart ?? (pending.length > 0 ? pending.shift() ?? null : command.eventId);
    const outcome = command.eventId === null ? null : (context?.resultRowIds.get(command.eventId) ?? command.eventId);
    runs.push({ run: command, key, start, outcome });
  }

  const retries = new Map<string, { command: string; count: number; firstEventId: number | null }>();
  const lastRun = new Map<string, (typeof runs)[number]>();
  for (const current of runs) {
    const previous = lastRun.get(current.key);
    if (previous && commandOutcome(previous.run) === "failed" && startedAfter(current.start, previous.outcome) && !editedBetween(editRows, previous.outcome, current.start)) {
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
    if (file.path.includes("[REDACTED:")) continue;
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

/** A command's identity: the exact string, with only leading and trailing whitespace trimmed. */
export function normalizeCommand(command: string): string {
  return command.trim();
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
