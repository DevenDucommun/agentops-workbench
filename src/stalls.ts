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

const NOT_EXECUTED = new Set(["inferred", "denied", "declined", "started", "in_progress", "running", "pending", "queued"]);

/**
 * `retry-without-change`: the same command re-run after it failed, with no file
 * change in between. One flag per command; medium once it was retried twice.
 * `repeated-edits`: one file changed at least `repeatedEditThreshold` times.
 * File changes are applied changes only: ingest skips the start half of a
 * start/completion pair and failed or denied attempts.
 */
export function detectStalls(commands: CommandRecord[], fileChanges: FileChangeRecord[], options: { repeatedEditThreshold: number }): StallFlag[] {
  const flags: StallFlag[] = [];
  const editRows = fileChanges.map((file) => file.eventId).filter((id): id is number => id !== null);

  const runs = commands.filter((command) => !NOT_EXECUTED.has(command.status ?? "")).sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0) || a.id - b.id);
  const retries = new Map<string, { command: string; count: number; firstEventId: number | null }>();
  const lastRun = new Map<string, CommandRecord>();
  for (const run of runs) {
    const key = normalizeCommand(run.command);
    const previous = lastRun.get(key);
    if (previous && failed(previous) && !editedBetween(editRows, previous.eventId, run.eventId)) {
      const entry = retries.get(key) ?? { command: key, count: 0, firstEventId: run.eventId };
      entry.count += 1;
      retries.set(key, entry);
    }
    lastRun.set(key, run);
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

/** Collapses whitespace between arguments, never inside quotes: `"a  b"` and `"a b"` are different paths. */
export function normalizeCommand(command: string): string {
  let out = "";
  let quote: string | null = null;
  let pendingSpace = false;
  for (const char of command.trim()) {
    if (quote === null && /\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    if (quote === null && (char === '"' || char === "'")) quote = char;
    else if (char === quote) quote = null;
    out += char;
  }
  return out;
}

function failed(run: CommandRecord): boolean {
  if (typeof run.exitCode === "number") return run.exitCode !== 0;
  return ["failed", "error"].includes((run.status ?? "").toLowerCase());
}

/** True when a file change sits between two runs. Runs without event rows cannot be ordered, so they count as separated. */
function editedBetween(editRows: number[], from: number | null, to: number | null): boolean {
  if (from === null || to === null) return true;
  return editRows.some((row) => row > from && row < to);
}
