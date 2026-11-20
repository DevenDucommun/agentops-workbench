import type { Store } from "./store";
import type { CommandRecord } from "./types";
import { getCommands } from "./store";

// Claims ledger (forensic recorder spec R2.1, R2.2). Every verification claim
// in the final response gets a verdict backed by the commands that ran before
// it: `supported` (the latest matching run passed), `contradicted` (the latest
// matching run failed and no later run passed) or `unsupported` (no matching
// run). Claims cite events by `eventId` (`agentops.event.v1`) and fall back to
// the stored event row ID for legacy sessions that have none.

export type EvidenceClaimId = "test" | "lint" | "typecheck" | "build";
export type ClaimVerdict = "supported" | "unsupported" | "contradicted";

export type EvidenceClaimRule = {
  id: EvidenceClaimId;
  category: string;
  claimPattern: RegExp;
  commandPattern: RegExp;
  label: string;
};

export type LedgerEvidence = {
  /** Stored event row ID. */
  eventRowId: number | null;
  /** `agentops.event.v1` eventId, when the source recorded one. */
  eventId: string | null;
  command: string;
  status: string | null;
  exitCode: number | null;
  outcome: "passed" | "failed";
};

export type LedgerClaim = {
  id: EvidenceClaimId;
  label: string;
  /** Risk category raised when the claim is unsupported (unchanged from v3.2). */
  category: string;
  verdict: ClaimVerdict;
  reason: string;
  /** Every matching run before the final response, in order. */
  evidence: LedgerEvidence[];
  /** The run the verdict rests on: the latest matching run, or null when unsupported. */
  cited: LedgerEvidence | null;
};

export type ClaimsLedger = {
  sessionId: string;
  finalEventRowId: number | null;
  finalEventId: string | null;
  claims: LedgerClaim[];
};

/**
 * A response-level claim pattern: the kind's subject vocabulary and any of its
 * success vocabulary both occur somewhere in the text, in either order.
 */
function responseClaim(subject: string, success: string): RegExp {
  return new RegExp(`\\b(?:${subject})\\b[\\s\\S]*\\b(?:${success})\\b|\\b(?:${success})\\b[\\s\\S]*\\b(?:${subject})\\b`, "i");
}

const SUCCESS = "pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified";

export const evidenceClaimRules: EvidenceClaimRule[] = [
  {
    id: "test",
    category: "missing-test-evidence",
    label: "test",
    claimPattern: responseClaim("test|tests|test suite|unit tests|integration tests", "pass(?:ed|es)?|passing|green|succeed(?:ed)?|successful|verified"),
    commandPattern: /\b(pytest|bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|cargo\s+test|go\s+test|make\s+test|gmake\s+test|mvn\s+test|gradle\s+test)\b/i
  },
  {
    id: "lint",
    category: "missing-lint-evidence",
    label: "lint",
    claimPattern: responseClaim("lint|linting|eslint", SUCCESS),
    commandPattern: /\b(eslint|bun\s+(?:run\s+)?lint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint|make\s+lint|gmake\s+lint)\b/i
  },
  {
    id: "typecheck",
    category: "missing-typecheck-evidence",
    label: "typecheck",
    claimPattern: responseClaim("typecheck|type check|type-check|type checking|tsc", SUCCESS),
    commandPattern: /\b(tsc|bun\s+(?:run\s+)?(?:typecheck|type-check)|npm\s+(?:run\s+)?(?:typecheck|type-check)|pnpm\s+(?:run\s+)?(?:typecheck|type-check)|yarn\s+(?:run\s+)?(?:typecheck|type-check)|make\s+(?:typecheck|type-check)|gmake\s+(?:typecheck|type-check))\b/i
  },
  {
    id: "build",
    category: "missing-build-evidence",
    label: "build",
    claimPattern: responseClaim("build|built|compile|compiled|compilation", `${SUCCESS}|complete(?:d)?`),
    commandPattern: /\b(bun\s+(?:run\s+)?build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|cargo\s+build|go\s+build|make\s+build|gmake\s+build|mvn\s+(?:package|compile)|gradle\s+build)\b/i
  }
];

/**
 * Whether the final response makes this rule's claim. Detection is response
 * level and over-detects (evidence trust model, rule 4): the kind is claimed
 * when its subject vocabulary and any of its success vocabulary both occur
 * anywhere in the text, even when negated, hedged or in different sentences.
 * A missed claim can produce a false pass; an extra one cannot.
 */
export function claimsRule(rule: Pick<EvidenceClaimRule, "claimPattern">, text: string): boolean {
  return rule.claimPattern.test(text.replace(/\s+/g, " "));
}

/** Plain printable ASCII only: no tabs, newlines, non-breaking spaces or other Unicode. */
const PLAIN_ASCII = /^[\x20-\x7e]*$/;
/** Shell syntax that chains, redirects, substitutes, quotes, escapes or comments. */
const SHELL_SYNTAX = /[;&|<>$`'"\\#]/;
/** Long flags that make a verification command print something instead of running. */
const NON_EXECUTING_FLAGS = new Set(["--help", "--version", "--dry-run", "--list", "--collect-only"]);
/** A single-dash argument containing h, V or n (`-h`, `-V`, `-kn`, `-run`): possibly help, version or dry-run. */
const MAYBE_NON_EXECUTING = /^-[^-][^ ]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^ ]*$/;

/**
 * Whether `command` has the shape of a run that can SUPPORT this rule's claim
 * (evidence trust model, rule 3): plain ASCII with no shell syntax
 * (`; & | < > $ \` ' " \ #`), the kind's pattern at the program position (after
 * leading `VAR=value` assignments) followed by a space or the end, no
 * single-dash argument containing `h`, `V` or `n`, and no `--help`,
 * `--version`, `--dry-run`, `--list` or `--collect-only`. Stricter than
 * necessary on purpose: a run that fails this test never supports a claim, but
 * if it failed it still contradicts one (see `mentionsRuleCommand`).
 */
export function runsRuleCommand(rule: Pick<EvidenceClaimRule, "commandPattern">, command: string): boolean {
  if (!PLAIN_ASCII.test(command) || SHELL_SYNTAX.test(command)) return false;
  const words = command.trim().split(/ +/);
  while (words.length > 0 && ASSIGNMENT.test(words[0])) words.shift();
  if (words.some((word) => NON_EXECUTING_FLAGS.has(word) || (MAYBE_NON_EXECUTING.test(word) && /[hVn]/.test(word)))) return false;
  const anchored = new RegExp(`^(?:${rule.commandPattern.source})(?= |$)`, rule.commandPattern.flags.replace(/[gy]/g, ""));
  return anchored.test(words.join(" "));
}

/**
 * Whether `command` mentions this rule's kind anywhere. A failed run that
 * mentions the kind contradicts a claim whatever its shape (quoted, wrapped,
 * chained or with any flags), so no support rule can hide a failure.
 */
export function mentionsRuleCommand(rule: Pick<EvidenceClaimRule, "commandPattern">, command: string): boolean {
  return new RegExp(rule.commandPattern.source, rule.commandPattern.flags.replace(/[gy]/g, "")).test(command);
}

/** Tools that execute shell commands: Claude `Bash`, Codex `shell`, and generic exec tools. */
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell"]);

/** Whether a stored tool name is a shell execution (`functions.exec_command` counts by its last segment). */
export function isShellTool(toolName: string | null | undefined): boolean {
  if (!toolName) return true;
  return SHELL_TOOLS.has(toolName.slice(toolName.lastIndexOf(".") + 1));
}

const NOT_EXECUTED_STATUSES = new Set(["inferred", "denied", "declined"]);
/**
 * A run that started but has not reported a result (e.g. Codex `item.started`)
 * proves nothing yet, nor does one whose result was never recorded (a Claude
 * Code tool_use with no matching tool_result: `no_result`).
 */
const NONTERMINAL_STATUSES = new Set(["in_progress", "started", "running", "pending", "queued", "no_result"]);
// Terminal statuses other than success: a run that timed out, was cancelled,
// interrupted or killed did not pass.
const FAILED_STATUSES = new Set(["failed", "error", "timed_out", "timeout", "cancelled", "canceled", "interrupted", "killed", "aborted"]);

const SUCCESS_STATUSES = new Set(["completed", "success", "succeeded", "passed", "ok"]);

/**
 * Whether a run recorded an outcome: an exit code, a failed terminal status or
 * a success status. A run without one (`skipped`, an unknown status, or none at
 * all) proves nothing and is never cited: unknown is never a pass.
 */
export function hasRecordedOutcome(command: Pick<CommandRecord, "status" | "exitCode">): boolean {
  if (typeof command.exitCode === "number") return true;
  const status = (command.status ?? "").toLowerCase();
  return FAILED_STATUSES.has(status) || SUCCESS_STATUSES.has(status);
}

/** A run failed when it reported a non-zero exit code or a failed status; otherwise it passed. Callers check `hasRecordedOutcome` first. */
export function commandOutcome(command: Pick<CommandRecord, "status" | "exitCode">): "passed" | "failed" {
  if (typeof command.exitCode === "number" && command.exitCode !== 0) return "failed";
  return FAILED_STATUSES.has((command.status ?? "").toLowerCase()) ? "failed" : "passed";
}

export type LedgerInput = {
  sessionId: string;
  /** `text` is the full final response when stored; `summary` is a producer's or display summary, checked as well. */
  finalEvent: { rowId: number; eventId: string | null; text: string; summary?: string | null } | null;
  commands: CommandRecord[];
  /** Stored event row ID -> `agentops.event.v1` eventId. */
  eventIds: Map<number, string>;
  /**
   * Command event row ID -> row ID of the event that recorded its result, when
   * the result arrived as a separate event (Claude Code `tool_result`). A run
   * whose result was recorded after the final response cannot back it.
   */
  resultRowIds?: Map<number, number>;
  /**
   * Command event row ID -> stored tool name. Only shell executions can support
   * a claim; when absent, every command is treated as a shell execution.
   */
  toolNames?: Map<number, string>;
};

/** Pure ledger construction over already-loaded session data. */
export function buildClaimsLedger(input: LedgerInput): ClaimsLedger {
  const { finalEvent } = input;
  const ledger: ClaimsLedger = { sessionId: input.sessionId, finalEventRowId: finalEvent?.rowId ?? null, finalEventId: finalEvent?.eventId ?? null, claims: [] };
  if (!finalEvent) return ledger;

  // Only runs that finished before the final response can back it: never-run
  // and still-running commands, and runs whose result came later, are skipped.
  // Commands without an event row keep their place in insertion order.
  const runs = input.commands.filter((command) => {
    const status = (command.status ?? "").toLowerCase();
    if (NOT_EXECUTED_STATUSES.has(status) || NONTERMINAL_STATUSES.has(status) || !hasRecordedOutcome(command)) return false;
    if (command.eventId === null) return true;
    const resultRowId = input.resultRowIds?.get(command.eventId);
    return command.eventId < finalEvent.rowId && (resultRowId === undefined || resultRowId < finalEvent.rowId);
  });
  // Runs are ordered by when their outcome was recorded, so with overlapping
  // calls the latest run is the one whose result arrived last. When two runs'
  // outcomes cannot be told apart, a failure sorts after a pass, so an
  // ambiguous order never hides a failure.
  const recordedAt = (command: CommandRecord) =>
    command.eventId === null ? null : (input.resultRowIds?.get(command.eventId) ?? command.eventId);
  const failedLast = (command: CommandRecord) => (commandOutcome(command) === "failed" ? 1 : 0);
  const ordered = runs
    .map((command, index) => ({ command, index, at: recordedAt(command) }))
    .sort((a, b) =>
      a.at === null || b.at === null
        ? a.index - b.index
        : a.at - b.at || failedLast(a.command) - failedLast(b.command) || a.index - b.index
    )
    .map((entry) => entry.command);
  const fromShell = (command: CommandRecord) => command.eventId === null || isShellTool(input.toolNames?.get(command.eventId));

  // Claims are read from the full final response and the summary together.
  const text = [...new Set([finalEvent.text, finalEvent.summary ?? ""])].join(" ");
  for (const rule of evidenceClaimRules) {
    if (!claimsRule(rule, text)) continue;
    // Evidence is asymmetric: any failed run that mentions the kind counts
    // against the claim; only a passing shell run of the strict shape counts for it.
    const evidence = ordered
      .filter((command) =>
        commandOutcome(command) === "failed" ? mentionsRuleCommand(rule, command.command) : fromShell(command) && runsRuleCommand(rule, command.command)
      )
      .map((command): LedgerEvidence => ({
        eventRowId: command.eventId,
        eventId: command.eventId === null ? null : (input.eventIds.get(command.eventId) ?? null),
        command: command.command,
        status: command.status,
        exitCode: command.exitCode,
        outcome: commandOutcome(command)
      }));
    const cited = evidence.at(-1) ?? null;
    ledger.claims.push({ id: rule.id, label: rule.label, category: rule.category, verdict: verdictFor(cited), reason: reasonFor(rule.label, cited, evidence.length), evidence, cited });
  }
  return ledger;
}

/** Ledger for a stored session's latest final response. */
export function getClaimsLedger(store: Store, sessionId: string): ClaimsLedger {
  const final = store.db
    // Claims are read from both the full final response (events.text, when the
    // store saved one) and the summary, which may be a producer's explicit one.
    .query("SELECT id, event_uid AS eventUid, text, summary FROM events WHERE session_id = $sid AND type = 'final_response' ORDER BY idx DESC LIMIT 1")
    .get({ $sid: sessionId }) as { id: number; eventUid: string | null; text: string | null; summary: string | null } | null;
  const uids = store.db.query("SELECT id, event_uid AS eventUid FROM events WHERE session_id = $sid AND event_uid IS NOT NULL").all({ $sid: sessionId }) as Array<{
    id: number;
    eventUid: string;
  }>;
  // A tool call's separate result event shares its tool_use_id. A result
  // belongs to the most recent call with that id before it, and a call's result
  // is the first one that belongs to it: the same rule the adapter uses for the
  // call's outcome. Results with no earlier call are ignored.
  const results = store.db
    .query(
      `SELECT call.id AS callRowId, MIN(result.id) AS resultRowId
       FROM events call JOIN events result
         ON result.session_id = call.session_id AND result.tool_use_id = call.tool_use_id AND result.type = 'tool_result' AND result.id > call.id
       WHERE call.session_id = $sid AND call.type <> 'tool_result' AND call.tool_use_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM events other
           WHERE other.session_id = call.session_id AND other.tool_use_id = call.tool_use_id AND other.type <> 'tool_result'
             AND other.id > call.id AND other.id < result.id
         )
       GROUP BY call.id`
    )
    .all({ $sid: sessionId }) as Array<{ callRowId: number; resultRowId: number }>;
  // Stores written before tool_use_id was recorded on Claude events have result
  // rows without it. A call's outcome then arrived no earlier than the first
  // such result after it; calls in the same turn share that position, and the
  // tie rule above keeps a failure among them from being hidden.
  const legacyResults = (
    store.db
      .query("SELECT id FROM events WHERE session_id = $sid AND type = 'tool_result' AND tool_use_id IS NULL ORDER BY id")
      .all({ $sid: sessionId }) as Array<{ id: number }>
  ).map((row) => row.id);
  const resultRowIds = new Map(results.map((row) => [row.callRowId, row.resultRowId]));
  if (legacyResults.length > 0) {
    const calls = store.db
      .query("SELECT id FROM events WHERE session_id = $sid AND type = 'tool_call' AND tool_use_id IS NULL")
      .all({ $sid: sessionId }) as Array<{ id: number }>;
    for (const { id } of calls) {
      const first = legacyResults.find((resultId) => resultId > id);
      if (first !== undefined && !resultRowIds.has(id)) resultRowIds.set(id, first);
    }
  }
  const tools = store.db.query("SELECT event_id AS eventId, tool_name AS toolName FROM tool_calls WHERE session_id = $sid AND event_id IS NOT NULL").all({ $sid: sessionId }) as Array<{
    eventId: number;
    toolName: string;
  }>;
  return buildClaimsLedger({
    sessionId,
    finalEvent: final ? { rowId: final.id, eventId: final.eventUid, text: final.text ?? final.summary ?? "", summary: final.summary } : null,
    commands: getCommands(store, sessionId),
    eventIds: new Map(uids.map((row) => [row.id, row.eventUid])),
    resultRowIds,
    toolNames: new Map(tools.map((row) => [row.eventId, row.toolName]))
  });
}

/** How a ledger entry names an event: its eventId, else `#<row id>`. */
export function eventRef(evidence: Pick<LedgerEvidence, "eventId" | "eventRowId">): string {
  return evidence.eventId ?? (evidence.eventRowId === null ? "unlinked" : `#${evidence.eventRowId}`);
}

function verdictFor(cited: LedgerEvidence | null): ClaimVerdict {
  if (!cited) return "unsupported";
  return cited.outcome === "passed" ? "supported" : "contradicted";
}

function reasonFor(label: string, cited: LedgerEvidence | null, runs: number): string {
  if (!cited) return `No observed ${label} command ran before the final response.`;
  const exit = cited.exitCode === null ? "" : ` (exit ${cited.exitCode})`;
  const earlier = runs > 1 ? `, after ${runs - 1} earlier run${runs === 2 ? "" : "s"}` : "";
  return cited.outcome === "passed"
    ? `Latest ${label} run passed: ${cited.command}${exit}${earlier}.`
    : `Latest ${label} run failed and was not re-run successfully: ${cited.command}${exit}${earlier}.`;
}
