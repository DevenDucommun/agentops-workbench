import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import type { Store } from "./store";
import { getCommands } from "./store";
import type { CommandRecord } from "./types";

// Claims ledger (forensic recorder spec R2.1, R2.2). Every claim the final
// response makes about verification gets a verdict backed by what ran before
// it: `supported` (the latest matching run passed), `contradicted` (the latest
// matching run failed and no later run passed) or `unsupported` (no matching
// run). Runs are shell commands and non-shell tool calls (Grep, browser and
// device tools). Claims cite events by `eventId` (`agentops.event.v1`) and fall
// back to the stored event row ID for legacy sessions that have none.

export type EvidenceClaimId = "test" | "lint" | "typecheck" | "build" | "callers" | "device" | "browser" | "fix";
export type ClaimVerdict = "supported" | "unsupported" | "contradicted";

/** One observed action that can back a claim: a shell command or a non-shell tool call. */
export type LedgerRun = {
  source: "command" | "tool";
  eventRowId: number | null;
  /** The command line, or the tool name for tool calls. */
  text: string;
  status: string | null;
  exitCode: number | null;
};

export type EvidenceClaimRule = {
  id: EvidenceClaimId;
  label: string;
  /** Risk category raised when the claim is unsupported. */
  category: string;
  claimPattern: RegExp;
  /** What the claim asserts, for flag messages ("test success", "no other callers"). */
  claimText: string;
  /** Flag message when no matching run was observed. */
  unsupportedMessage: string;
  /** Shell commands that back the claim (also what the dashboard matches on). */
  commandPattern?: RegExp;
  /** Non-shell tool names that back the claim. */
  toolPattern?: RegExp;
  /** Pass/fail of a matching run; defaults to {@link commandOutcome}. */
  outcome?: (run: LedgerRun) => "passed" | "failed";
  /** "fix": only verification runs after the last file change count. */
  afterLastEdit?: boolean;
};

export type LedgerEvidence = {
  source: "command" | "tool";
  /** Stored event row ID. */
  eventRowId: number | null;
  /** `agentops.event.v1` eventId, when the source recorded one. */
  eventId: string | null;
  /** The command line, or the tool name. */
  command: string;
  status: string | null;
  exitCode: number | null;
  outcome: "passed" | "failed";
};

export type LedgerClaim = {
  id: EvidenceClaimId;
  label: string;
  category: string;
  claimText: string;
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

const PASS = "(?:pass(?:ed|es)?|passing|green|succeed(?:ed)?|successful|verified)";
const CLEAN = "(?:pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified)";

/** Searches: exit 1 means "no matches", which is evidence too; only errors (exit 2+) fail. */
function searchOutcome(run: LedgerRun): "passed" | "failed" {
  if (typeof run.exitCode === "number") return run.exitCode >= 2 ? "failed" : "passed";
  return commandOutcome(run);
}

export const evidenceClaimRules: EvidenceClaimRule[] = [
  {
    id: "test",
    category: "missing-test-evidence",
    label: "test",
    claimText: "test success",
    unsupportedMessage: "Final response claims test success, but no observed matching test command was recorded.",
    claimPattern: new RegExp(String.raw`\b(test|tests|test suite|unit tests|integration tests)\b[\s\S]{0,80}\b${PASS}\b|\b(pass(?:ed|es)?|passing|green)\b[\s\S]{0,80}\b(test|tests|test suite)\b`, "i"),
    commandPattern: /\b(pytest|bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|cargo\s+test|go\s+test|make\s+test|gmake\s+test|mvn\s+test|gradle\s+test)\b/i
  },
  {
    id: "lint",
    category: "missing-lint-evidence",
    label: "lint",
    claimText: "lint success",
    unsupportedMessage: "Final response claims lint success, but no observed matching lint command was recorded.",
    claimPattern: new RegExp(String.raw`\b(lint|linting|eslint)\b[\s\S]{0,80}\b${CLEAN}\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(lint|linting|eslint)\b`, "i"),
    commandPattern: /\b(eslint|bun\s+(?:run\s+)?lint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint|make\s+lint|gmake\s+lint)\b/i
  },
  {
    id: "typecheck",
    category: "missing-typecheck-evidence",
    label: "typecheck",
    claimText: "typecheck success",
    unsupportedMessage: "Final response claims typecheck success, but no observed matching typecheck command was recorded.",
    claimPattern: new RegExp(
      String.raw`\b(typecheck|type check|type-check|type checking|tsc)\b[\s\S]{0,80}\b${CLEAN}\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(typecheck|type check|type-check|type checking|tsc)\b`,
      "i"
    ),
    commandPattern: /\b(tsc|bun\s+(?:run\s+)?(?:typecheck|type-check)|npm\s+(?:run\s+)?(?:typecheck|type-check)|pnpm\s+(?:run\s+)?(?:typecheck|type-check)|yarn\s+(?:run\s+)?(?:typecheck|type-check)|make\s+(?:typecheck|type-check)|gmake\s+(?:typecheck|type-check))\b/i
  },
  {
    id: "build",
    category: "missing-build-evidence",
    label: "build",
    claimText: "build success",
    unsupportedMessage: "Final response claims build success, but no observed matching build command was recorded.",
    claimPattern: /\b(build|built|compile|compiled|compilation)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified|complete(?:d)?)\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(build|compile|compilation)\b/i,
    commandPattern: /\b(bun\s+(?:run\s+)?build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|cargo\s+build|go\s+build|make\s+build|gmake\s+build|mvn\s+(?:package|compile)|gradle\s+build)\b/i
  },
  {
    id: "callers",
    category: "missing-callers-evidence",
    label: "search",
    claimText: "there are no other callers or usages",
    unsupportedMessage: "Final response claims there are no other callers or usages, but no code search was recorded.",
    claimPattern:
      /\b(no|zero)\s+(other\s+|remaining\s+|external\s+|more\s+)?(callers?|usages?|references|call\s*sites?|consumers|importers)\b|\b(is\s+not|isn't|are\s+not|aren't|not)\s+(used|called|referenced|imported)\s+(anywhere|elsewhere)\b|\b(only|sole)\s+(caller|call\s*site|usage|consumer)\b/i,
    commandPattern: /(^|[\s|;&(])(rg|grep|egrep|ag|ack|git\s+grep)\s/i,
    toolPattern: /^(grep|glob|search|search_code|codebase_search|grep_search|find_references)$|references/i,
    outcome: searchOutcome
  },
  {
    id: "device",
    category: "missing-device-evidence",
    label: "device",
    claimText: "verification on a device",
    unsupportedMessage: "Final response claims verification on a device, but no device command or tool call was recorded.",
    claimPattern:
      /\b(verified|tested|confirmed|checked|validated)\b[\s\S]{0,60}\b(on|against)\s+(the\s+|a\s+|real\s+|live\s+)*(device|router|hardware|board|target|phone)\b|\bon-device\b[\s\S]{0,40}\b(verified|tested|confirmed|works|passed)\b/i,
    commandPattern: /(^|[\s|;&(])(ssh|scp|adb|fastboot|telnet|picocom|minicom|ubus|uci)\s/i,
    toolPattern: /ssh|serial|console|device|router|adb|lab_/i
  },
  {
    id: "browser",
    category: "missing-browser-evidence",
    label: "browser",
    claimText: "verification in a browser",
    unsupportedMessage: "Final response claims verification in a browser, but no browser run or tool call was recorded.",
    claimPattern:
      /\b(verified|tested|confirmed|checked|validated)\b[\s\S]{0,60}\bin\s+(the\s+|a\s+)?(browser|chrome|chromium|firefox|safari)\b|\b(browser|e2e|end-to-end)\s+tests?\b[\s\S]{0,40}\b(pass(?:ed|es)?|passing|green)\b/i,
    commandPattern: /\b(playwright|cypress|puppeteer|webdriver|selenium|lighthouse)\b/i,
    toolPattern: /browser|playwright|puppeteer|chrome|webdriver/i
  },
  {
    id: "fix",
    category: "missing-fix-evidence",
    label: "verification",
    claimText: "a fix",
    unsupportedMessage: "Final response claims a fix, but no verification command ran after the last edit.",
    claimPattern: /\b(fixed|resolved)\b|\bnow\s+(works|passes|working|passing)\b/i,
    afterLastEdit: true
  }
];

const NOT_EXECUTED_STATUSES = new Set(["inferred", "denied", "declined"]);
const FAILED_STATUSES = new Set(["failed", "error"]);

/** A run failed when it reported a non-zero exit code or a failed status; a run with neither counts as passed. */
export function commandOutcome(run: Pick<CommandRecord, "status" | "exitCode">): "passed" | "failed" {
  if (typeof run.exitCode === "number" && run.exitCode !== 0) return "failed";
  return FAILED_STATUSES.has((run.status ?? "").toLowerCase()) ? "failed" : "passed";
}

export function isVerificationCommand(command: string, config: AgentOpsConfig = defaultConfig): boolean {
  const keywords = config.evidence.verificationCommands.map(escapeRegex).join("|");
  const pattern = new RegExp(`\\b(bun|npm|pnpm|yarn|pytest|cargo|go|make|gmake|mvn|gradle)\\s+([^\\n]*\\b)?(${keywords})\\b`, "i");
  return pattern.test(command);
}

export type LedgerInput = {
  sessionId: string;
  finalEvent: { rowId: number; eventId: string | null; text: string } | null;
  /** Commands and tool calls in session order. Plain command records are accepted as command runs. */
  runs: Array<LedgerRun | CommandRecord>;
  /** Stored event row ID -> `agentops.event.v1` eventId. */
  eventIds: Map<number, string>;
  /** Event row of the last file change before the final response, if any. */
  lastEditRowId?: number | null;
  config?: AgentOpsConfig;
};

/** Pure ledger construction over already-loaded session data. */
export function buildClaimsLedger(input: LedgerInput): ClaimsLedger {
  const { finalEvent } = input;
  const config = input.config ?? defaultConfig;
  const ledger: ClaimsLedger = { sessionId: input.sessionId, finalEventRowId: finalEvent?.rowId ?? null, finalEventId: finalEvent?.eventId ?? null, claims: [] };
  if (!finalEvent) return ledger;

  // Only runs that executed before the final response can back it. Runs
  // without an event row keep their place in session order.
  const runs = input.runs
    .map(toRun)
    .filter((run) => !NOT_EXECUTED_STATUSES.has(run.status ?? "") && (run.eventRowId === null || run.eventRowId < finalEvent.rowId));

  for (const rule of evidenceClaimRules) {
    if (!rule.claimPattern.test(finalEvent.text)) continue;
    const outcome = rule.outcome ?? commandOutcome;
    const evidence = runs
      .filter((run) => matches(rule, run, input.lastEditRowId ?? null, config))
      .map((run): LedgerEvidence => ({
        source: run.source,
        eventRowId: run.eventRowId,
        eventId: run.eventRowId === null ? null : (input.eventIds.get(run.eventRowId) ?? null),
        command: run.text,
        status: run.status,
        exitCode: run.exitCode,
        outcome: outcome(run)
      }));
    const cited = evidence.at(-1) ?? null;
    ledger.claims.push({
      id: rule.id,
      label: rule.label,
      category: rule.category,
      claimText: rule.claimText,
      verdict: verdictFor(cited),
      reason: reasonFor(rule, cited, evidence.length),
      evidence,
      cited
    });
  }
  return ledger;
}

/** Ledger for a stored session's latest final response. */
export function getClaimsLedger(store: Store, sessionId: string, config: AgentOpsConfig = defaultConfig): ClaimsLedger {
  const $sid = sessionId;
  const final = store.db
    .query("SELECT id, event_uid AS eventUid, summary FROM events WHERE session_id = $sid AND type = 'final_response' ORDER BY idx DESC LIMIT 1")
    .get({ $sid }) as { id: number; eventUid: string | null; summary: string } | null;
  const uids = store.db.query("SELECT id, event_uid AS eventUid FROM events WHERE session_id = $sid AND event_uid IS NOT NULL").all({ $sid }) as Array<{ id: number; eventUid: string }>;
  // Shell tool calls are already in `commands`; other tool calls (Grep, browser, device tools) are runs too.
  const tools = store.db
    .query("SELECT id, event_id AS eventId, tool_name AS toolName, status FROM tool_calls WHERE session_id = $sid AND category != 'shell' ORDER BY id")
    .all({ $sid }) as Array<{ id: number; eventId: number | null; toolName: string; status: string | null }>;
  const lastEdit = final
    ? (store.db.query("SELECT MAX(event_id) AS id FROM file_changes WHERE session_id = $sid AND event_id < $final").get({ $sid, $final: final.id }) as { id: number | null } | null)
    : null;

  const runs: LedgerRun[] = [
    ...getCommands(store, sessionId).map(toRun),
    ...tools.map((tool): LedgerRun => ({ source: "tool", eventRowId: tool.eventId, text: tool.toolName, status: tool.status, exitCode: null }))
  ];
  runs.sort((a, b) => (a.eventRowId ?? -1) - (b.eventRowId ?? -1));
  return buildClaimsLedger({
    sessionId,
    finalEvent: final ? { rowId: final.id, eventId: final.eventUid, text: final.summary } : null,
    runs,
    eventIds: new Map(uids.map((row) => [row.id, row.eventUid])),
    lastEditRowId: lastEdit?.id ?? null,
    config
  });
}

/** How a ledger entry names an event: its eventId, else `#<row id>`. */
export function eventRef(evidence: Pick<LedgerEvidence, "eventId" | "eventRowId">): string {
  return evidence.eventId ?? (evidence.eventRowId === null ? "unlinked" : `#${evidence.eventRowId}`);
}

function toRun(run: LedgerRun | CommandRecord): LedgerRun {
  if ("source" in run) return run;
  return { source: "command", eventRowId: run.eventId, text: run.command, status: run.status, exitCode: run.exitCode };
}

function matches(rule: EvidenceClaimRule, run: LedgerRun, lastEditRowId: number | null, config: AgentOpsConfig): boolean {
  if (rule.afterLastEdit) {
    if (run.source !== "command" || !isVerificationCommand(run.text, config)) return false;
    return lastEditRowId === null || run.eventRowId === null || run.eventRowId > lastEditRowId;
  }
  if (run.source === "command") return rule.commandPattern?.test(run.text) ?? false;
  return rule.toolPattern?.test(run.text) ?? false;
}

function verdictFor(cited: LedgerEvidence | null): ClaimVerdict {
  if (!cited) return "unsupported";
  return cited.outcome === "passed" ? "supported" : "contradicted";
}

function reasonFor(rule: EvidenceClaimRule, cited: LedgerEvidence | null, runs: number): string {
  if (!cited) return rule.afterLastEdit ? "No verification command ran after the last edit." : `No observed ${rule.label} run before the final response.`;
  const exit = cited.exitCode === null ? "" : ` (exit ${cited.exitCode})`;
  const earlier = runs > 1 ? `, after ${runs - 1} earlier run${runs === 2 ? "" : "s"}` : "";
  return cited.outcome === "passed"
    ? `Latest ${rule.label} run passed: ${cited.command}${exit}${earlier}.`
    : `Latest ${rule.label} run failed and was not re-run successfully: ${cited.command}${exit}${earlier}.`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
