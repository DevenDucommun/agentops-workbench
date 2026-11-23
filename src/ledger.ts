import type { Store } from "./store";
import type { CommandRecord } from "./types";
import { getCommands } from "./store";
import { type AgentOpsConfig, defaultConfig } from "./config";

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

/** Built-in commands that can support each claim kind, matched word for word (rule 3). */
export const DEFAULT_SUPPORT_COMMANDS: Record<EvidenceClaimId, string[]> = {
  test: ["bun test", "bun run test", "npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "yarn run test", "pytest", "cargo test", "go test ./...", "make test", "gmake test", "mvn test", "gradle test"],
  lint: ["bun run lint", "npm run lint", "pnpm run lint", "pnpm lint", "yarn lint", "yarn run lint", "eslint .", "make lint", "gmake lint"],
  typecheck: ["tsc --noEmit", "bun run typecheck", "npm run typecheck", "pnpm run typecheck", "pnpm typecheck", "yarn typecheck", "yarn run typecheck", "make typecheck", "gmake typecheck"],
  build: ["bun run build", "npm run build", "pnpm run build", "pnpm build", "yarn build", "yarn run build", "cargo build", "go build ./...", "make build", "gmake build", "mvn package", "gradle build"]
};

/**
 * Whether `command` is one of the kind's configured commands, word for word
 * (evidence trust model, rule 3). Extra arguments, environment assignments,
 * wrappers and shell syntax all make the run unable to support the claim; a
 * repository adds the exact forms it uses to `evidence.supportCommands`.
 */
export function isSupportCommand(rule: Pick<EvidenceClaimRule, "id">, command: string, config: AgentOpsConfig = defaultConfig): boolean {
  const normalized = normalizeCommand(command);
  if (normalized === null) return false;
  const configured = config.evidence.supportCommands?.[rule.id] ?? DEFAULT_SUPPORT_COMMANDS[rule.id];
  return configured.some((candidate) => isSafeSupportCommand(candidate) && normalizeCommand(candidate) === normalized);
}

/**
 * A support command, or one with more arguments after it (`node --test
 * runner.test.cjs`). Used only for failures: a failed run of a narrowed check
 * still counts against the claim, while support stays word for word.
 */
function extendsSupportCommand(rule: Pick<EvidenceClaimRule, "id">, command: string, config: AgentOpsConfig = defaultConfig): boolean {
  // Failures only, so every spelling below can only add contradictions.
  // Configured entries are compared as written (tabs read as spaces), so two
  // entries that differ only in an assignment (`CHECK=unit node verify.cjs`
  // and `CHECK=lint node verify.cjs`) never match each other's runs. Only the
  // observed command is varied: tabs as spaces, a leading `env` wrapper
  // dropped, and leading VAR=value assignments dropped one at a time. So a
  // failed `CI=1 node --test x`, `env CI=1 node --test x`,
  // `A=1 CI=1 node<TAB>--test x` or `node --test x` still counts against a
  // configured `CI=1 node --test` or `node --test`.
  // An observed command with no assignments of its own (`node --test x`) is
  // also compared with the configured entry's assignments removed; one that
  // carries assignments must match them as written.
  const configured = config.evidence.supportCommands?.[rule.id] ?? DEFAULT_SUPPORT_COMMANDS[rule.id];
  const observed = observedFailureSpellings(command);
  if (observed.length === 0) return false;
  const bare = !LEADING_ASSIGNMENT.test(command.replace(/\t/g, " ").replace(/^\s*env\s+/, ""));
  const matches = (base: string | null) =>
    base !== null && base !== "" && observed.some((spelling) => spelling === base || spelling.startsWith(`${base} `));
  // Keep environment selectors for as long as a configured command matches.
  // Within each spelling the longest whole-word command owns a narrowed run.
  const kinds = Object.keys(DEFAULT_SUPPORT_COMMANDS) as EvidenceClaimId[];
  for (const spelling of observed) {
    let longest = 0;
    let matchesKind = false;
    for (const kind of kinds) {
      const entries = config.evidence.supportCommands?.[kind] ?? DEFAULT_SUPPORT_COMMANDS[kind];
      for (const entry of entries) {
        const base = normalizeCommand(entry.replace(/\t/g, " "));
        if (!base || base.length < longest || (spelling !== base && !spelling.startsWith(`${base} `))) continue;
        if (base.length > longest) matchesKind = false;
        longest = base.length;
        if (kind === rule.id) matchesKind = true;
      }
    }
    if (longest > 0) return matchesKind;
  }
  return configured.some((candidate) => {
    const spaced = candidate.replace(/\t/g, " ");
    return bare && matches(normalizeCommand(stripLeadingAssignments(spaced)));
  });
}

const LEADING_ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;

function stripLeadingAssignments(command: string): string {
  let rest = command;
  while (LEADING_ASSIGNMENT.test(rest)) rest = rest.replace(LEADING_ASSIGNMENT, "");
  return rest;
}

/** The observed command as written, then with tabs as spaces, a leading `env` dropped, and each count of leading assignments dropped. */
function observedFailureSpellings(command: string): string[] {
  const spellings = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeCommand(value);
    if (normalized !== null) spellings.add(normalized);
  };
  add(command);
  const spaced = command.replace(/\t/g, " ");
  for (const start of [spaced, spaced.replace(/^\s*env\s+/, "")]) {
    let rest = start;
    add(rest);
    while (LEADING_ASSIGNMENT.test(rest)) {
      rest = rest.replace(LEADING_ASSIGNMENT, "");
      add(rest);
    }
  }
  return [...spellings];
}

/** ASCII spaces collapsed and trimmed; null for anything that is not plain printable ASCII (a non-breaking space, a tab, a newline). */
function normalizeCommand(command: string): string | null {
  if (!PLAIN_ASCII.test(command)) return null;
  return command.replace(/ +/g, " ").replace(/^ | $/g, "");
}

/**
 * Whether a configured support command is acceptable (evidence trust model,
 * rule 3). Configured commands are the repository owner's statement of what
 * runs its checks and are trusted as written, environment assignments
 * included. Only structure the ledger can verify is refused: shell syntax or
 * `!` negation (the outcome would not be the command's), and the non-executing
 * flags rule 3 names (`-h`, `--help`, `-V`, `--version`, `--dry-run`, `--list`,
 * `--collect-only`) as whole words. Program-specific dry-run spellings
 * (`make -n`, `go test -n`) are the owner's to leave out of the list.
 */
export function isSafeSupportCommand(candidate: string): boolean {
  const normalized = normalizeCommand(candidate);
  if (!normalized || SHELL_SYNTAX.test(normalized)) return false;
  const words = normalized.split(" ");
  return !words.includes("!") && !words.some((word) => SUPPORT_NON_EXECUTING.has(word));
}

/** The non-executing flags rule 3 names, matched as whole words. */
const SUPPORT_NON_EXECUTING = new Set(["-h", "--help", "-V", "--version", "--dry-run", "--list", "--collect-only"]);

/**
 * Whether `command` mentions this rule's kind anywhere. A failed run that
 * mentions the kind contradicts a claim whatever its shape (quoted, wrapped,
 * chained or with any flags), so no support rule can hide a failure.
 */
export function mentionsRuleCommand(rule: Pick<EvidenceClaimRule, "commandPattern">, command: string): boolean {
  return new RegExp(rule.commandPattern.source, rule.commandPattern.flags.replace(/[gy]/g, "")).test(command);
}

const KIND_WORDS: Record<string, string> = { test: "test", lint: "lint", typecheck: "typecheck|type-check", build: "build|package|compile" };

/**
 * A failed run counts against a claim at least as broadly as v3.2 matched runs:
 * a known tool followed, anywhere later on the line, by the kind's word, flags
 * in between included (`npm --silent test`, `make -C unit test`). Used only for
 * failures; support stays word for word.
 */
function looselyMentionsKind(rule: Pick<EvidenceClaimRule, "id">, command: string): boolean {
  const words = KIND_WORDS[rule.id];
  if (!words) return false;
  return new RegExp(`\\b(bun|npm|pnpm|yarn|npx|pytest|cargo|go|make|gmake|mvn|gradle)\\s+([^\\n]*\\b)?(${words})\\b`, "i").test(command);
}

/** Tools that execute shell commands: Claude `Bash`, Codex `shell`, and generic exec tools. */
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell"]);

/**
 * Whether a stored tool name is a shell execution. Names match exactly, plus
 * Codex's `functions.<tool>` form; an MCP tool or any other name that merely
 * ends in a shell word (`docs.shell`, `mcp__x__shell`) is not one.
 */
export function isShellTool(toolName: string | null | undefined): boolean {
  if (!toolName) return true;
  return SHELL_TOOLS.has(toolName.startsWith("functions.") ? toolName.slice("functions.".length) : toolName);
}

/** Whether a command row came from a shell execution: a `command` event, or a `tool_call` of a shell tool. */
export function isShellExecution(eventType: string | undefined, toolName: string | undefined): boolean {
  if (eventType === undefined) return isShellTool(toolName);
  if (eventType === "command") return true;
  return eventType === "tool_call" && isShellTool(toolName);
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
  /** Command event row ID -> stored event type. Only `command` events and shell `tool_call`s can support a claim. */
  eventTypes?: Map<number, string>;
  /**
   * Whether a linked result's outcome was written onto the call at ingest
   * (Claude Code stream sessions). Elsewhere a command's own status without an
   * exit code is not an outcome.
   */
  linkedStatusIsOutcome?: boolean;
  /** Supplies `evidence.supportCommands`; defaults apply when absent. */
  config?: AgentOpsConfig;
};

/** Pure ledger construction over already-loaded session data. */
export function buildClaimsLedger(input: LedgerInput): ClaimsLedger {
  const { finalEvent } = input;
  const ledger: ClaimsLedger = { sessionId: input.sessionId, finalEventRowId: finalEvent?.rowId ?? null, finalEventId: finalEvent?.eventId ?? null, claims: [] };
  if (!finalEvent) return ledger;

  // Only runs that finished before the final response can back it: never-run
  // and still-running commands, and runs whose result came later, are skipped.
  // Commands without an event row keep their place in insertion order.
  // A run counts only with its own recorded outcome (evidence trust model,
  // rule 1): an exit code, an explicit failed status, or, in a Claude Code
  // stream session, the result linked to the call by tool_use_id. A status such
  // as "completed" with none of these is not evidence, so a tool call that only
  // mentions a command (an MCP lookup, a file write) or a call from a store
  // that never recorded its result is never cited. A failure always counts.
  const hasOwnOutcome = (command: CommandRecord) => {
    if (typeof command.exitCode === "number") return true;
    const status = (command.status ?? "").toLowerCase();
    if (FAILED_STATUSES.has(status)) return true;
    if (command.eventId === null) return SUCCESS_STATUSES.has(status);
    return Boolean(input.linkedStatusIsOutcome) && input.resultRowIds?.has(command.eventId) === true && SUCCESS_STATUSES.has(status);
  };
  // A run with its own exit code or failed status recorded its outcome on its own
  // row; only a run whose outcome is its linked result (Claude Code) is placed at
  // that result. A later, separate result never hides or reorders an outcome
  // that was already recorded.
  // In a Claude Code stream session the status was written from the linked
  // tool_result, so its outcome (pass or fail) is placed at that result.
  const outcomeFromLinkedResult = (command: CommandRecord) =>
    Boolean(input.linkedStatusIsOutcome) && command.eventId !== null && input.resultRowIds?.has(command.eventId) === true;
  const ownOutcomeOnRow = (command: CommandRecord) =>
    typeof command.exitCode === "number" || (FAILED_STATUSES.has((command.status ?? "").toLowerCase()) && !outcomeFromLinkedResult(command));
  const outcomeRow = (command: CommandRecord): number | null => {
    if (command.eventId === null) return null;
    if (ownOutcomeOnRow(command)) return command.eventId;
    return input.resultRowIds?.get(command.eventId) ?? command.eventId;
  };
  // Only runs whose outcome was recorded before the final response can back it:
  // never-run and still-running commands, and runs whose result came later, are
  // skipped. Commands without an event row keep their place in insertion order.
  const runs = input.commands.filter((command) => {
    const status = (command.status ?? "").toLowerCase();
    if (NOT_EXECUTED_STATUSES.has(status) || NONTERMINAL_STATUSES.has(status) || !hasOwnOutcome(command)) return false;
    const at = outcomeRow(command);
    return at === null || at < finalEvent.rowId;
  });
  // Runs are ordered by when their outcome was recorded, so with overlapping
  // calls the latest run is the one whose result arrived last. When two runs'
  // outcomes cannot be told apart, a failure sorts after a pass, so an
  // ambiguous order never hides a failure.
  const failedLast = (command: CommandRecord) => (commandOutcome(command) === "failed" ? 1 : 0);
  const ordered = runs
    .map((command, index) => ({ command, index, at: outcomeRow(command) }))
    .sort((a, b) =>
      a.at === null || b.at === null
        ? a.index - b.index
        : a.at - b.at || failedLast(a.command) - failedLast(b.command) || a.index - b.index
    )
    .map((entry) => entry.command);
  const fromShell = (command: CommandRecord) =>
    command.eventId === null || isShellExecution(input.eventTypes?.get(command.eventId), input.toolNames?.get(command.eventId));

  // Claims are read from the full final response and the summary together.
  const text = [...new Set([finalEvent.text, finalEvent.summary ?? ""])].join(" ");
  for (const rule of evidenceClaimRules) {
    if (!claimsRule(rule, text)) continue;
    // Evidence is asymmetric: any failed run that mentions the kind counts
    // against the claim; only a passing shell run of a configured command,
    // word for word (rule 3), counts for it.
    const evidence = ordered
      .filter((command) =>
        commandOutcome(command) === "failed"
          ? mentionsRuleCommand(rule, command.command) || looselyMentionsKind(rule, command.command) || extendsSupportCommand(rule, command.command, input.config)
          : fromShell(command) && isSupportCommand(rule, command.command, input.config)
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
export function getClaimsLedger(store: Store, sessionId: string, config: AgentOpsConfig = defaultConfig): ClaimsLedger {
  // Every read below comes from one transaction, so a re-import committing in
  // between can never pair the old final response with the new command rows.
  return store.db.transaction(() => readClaimsLedger(store, sessionId, config))();
}

function readClaimsLedger(store: Store, sessionId: string, config: AgentOpsConfig): ClaimsLedger {
  const final = store.db
    // Claims are read from both the full final response (events.text, when the
    // store saved one) and the summary, which may be a producer's explicit one.
    .query(
      `SELECT id, event_uid AS eventUid, ${hasEventText(store) ? "text" : "NULL AS text"}, summary FROM events WHERE session_id = $sid AND type = 'final_response' ORDER BY idx DESC LIMIT 1`
    )
    .get({ $sid: sessionId }) as { id: number; eventUid: string | null; text: string | null; summary: string | null } | null;
  const uids = store.db.query("SELECT id, event_uid AS eventUid FROM events WHERE session_id = $sid AND event_uid IS NOT NULL").all({ $sid: sessionId }) as Array<{
    id: number;
    eventUid: string;
  }>;
  const { resultRowIds, toolNames, eventTypes } = getCommandContext(store, sessionId);
  const adapter = store.db.query("SELECT source_adapter AS sourceAdapter FROM sessions WHERE id = $sid").get({ $sid: sessionId }) as { sourceAdapter: string | null } | null;
  return buildClaimsLedger({
    sessionId,
    finalEvent: final ? { rowId: final.id, eventId: final.eventUid, text: final.text ?? final.summary ?? "", summary: final.summary } : null,
    commands: getCommands(store, sessionId),
    linkedStatusIsOutcome: adapter?.sourceAdapter === "claude-code-stream-json",
    config,
    eventIds: new Map(uids.map((row) => [row.id, row.eventUid])),
    resultRowIds,
    toolNames,
    eventTypes
  });
}

/** What a stored session records about each command row: its linked result row, tool name and event type. */
export type CommandContext = {
  hookStartRows: Map<number, number>;
  resultRowIds: Map<number, number>;
  toolNames: Map<number, string>;
  eventTypes: Map<number, string>;
  /** Recorded agent and invocation identity, shared by start and outcome events. */
  invocationKeys: Map<number, string>;
};

export function getCommandContext(store: Store, sessionId: string): CommandContext {
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
  const tools = store.db.query("SELECT event_id AS eventId, tool_name AS toolName FROM tool_calls WHERE session_id = $sid AND event_id IS NOT NULL").all({ $sid: sessionId }) as Array<{
    eventId: number;
    toolName: string;
  }>;
  const events = store.db.query(`
    SELECT id, type, tool_use_id AS invocation, agent_id AS agent FROM events WHERE session_id = $sid ORDER BY id
  `).all({ $sid: sessionId }) as Array<{ id: number; type: string; invocation: string | null; agent: string | null }>;
  const invocationKeys = new Map<number, string>();
  const hookStartRows = new Map<number, number>();
  const pending = new Map<string, number>();
  for (const event of events) {
    if (!event.invocation || event.invocation.includes("[REDACTED:") || event.agent?.includes("[REDACTED:")) continue;
    const key = JSON.stringify([event.agent, event.invocation]);
    invocationKeys.set(event.id, key);
    if (event.type === "tool_started") {
      pending.set(key, event.id);
    } else {
      const start = pending.get(key);
      if (start !== undefined) hookStartRows.set(event.id, start);
      pending.delete(key);
    }
  }
  return {
    hookStartRows,
    invocationKeys,
    resultRowIds: new Map(results.map((row) => [row.callRowId, row.resultRowId])),
    toolNames: new Map(tools.map((row) => [row.eventId, row.toolName])),
    eventTypes: new Map(events.map((row) => [row.id, row.type]))
  };
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

/** Stores from earlier versions gain events.text on their first write; until then a read treats it as absent. */
function hasEventText(store: Store): boolean {
  return (store.db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).some((column) => column.name === "text");
}
