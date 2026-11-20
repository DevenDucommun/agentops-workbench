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

export const evidenceClaimRules: EvidenceClaimRule[] = [
  {
    id: "test",
    category: "missing-test-evidence",
    label: "test",
    claimPattern: /\b(test|tests|test suite|unit tests|integration tests)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|green|succeed(?:ed)?|successful|verified)\b|\b(pass(?:ed|es)?|passing|green)\b[\s\S]{0,80}\b(test|tests|test suite)\b/i,
    commandPattern: /\b(pytest|bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|cargo\s+test|go\s+test|make\s+test|gmake\s+test|mvn\s+test|gradle\s+test)\b/i
  },
  {
    id: "lint",
    category: "missing-lint-evidence",
    label: "lint",
    claimPattern: /\b(lint|linting|eslint)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified)\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(lint|linting|eslint)\b/i,
    commandPattern: /\b(eslint|bun\s+(?:run\s+)?lint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint|make\s+lint|gmake\s+lint)\b/i
  },
  {
    id: "typecheck",
    category: "missing-typecheck-evidence",
    label: "typecheck",
    claimPattern: /\b(typecheck|type check|type-check|type checking|tsc)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified)\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(typecheck|type check|type-check|type checking|tsc)\b/i,
    commandPattern: /\b(tsc|bun\s+(?:run\s+)?(?:typecheck|type-check)|npm\s+(?:run\s+)?(?:typecheck|type-check)|pnpm\s+(?:run\s+)?(?:typecheck|type-check)|yarn\s+(?:run\s+)?(?:typecheck|type-check)|make\s+(?:typecheck|type-check)|gmake\s+(?:typecheck|type-check))\b/i
  },
  {
    id: "build",
    category: "missing-build-evidence",
    label: "build",
    claimPattern: /\b(build|built|compile|compiled|compilation)\b[\s\S]{0,80}\b(pass(?:ed|es)?|passing|clean|green|succeed(?:ed)?|successful|verified|complete(?:d)?)\b|\b(pass(?:ed|es)?|passing|clean|green)\b[\s\S]{0,80}\b(build|compile|compilation)\b/i,
    commandPattern: /\b(bun\s+(?:run\s+)?build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|cargo\s+build|go\s+build|make\s+build|gmake\s+build|mvn\s+(?:package|compile)|gradle\s+build)\b/i
  }
];

const NOT_EXECUTED_STATUSES = new Set(["inferred", "denied", "declined"]);
/** A run that started but has not reported a result (e.g. Codex `item.started`) proves nothing yet. */
const NONTERMINAL_STATUSES = new Set(["in_progress", "started", "running", "pending", "queued"]);
const FAILED_STATUSES = new Set(["failed", "error"]);

/** A run failed when it reported a non-zero exit code or a failed status; a run with neither counts as passed. */
export function commandOutcome(command: Pick<CommandRecord, "status" | "exitCode">): "passed" | "failed" {
  if (typeof command.exitCode === "number" && command.exitCode !== 0) return "failed";
  return FAILED_STATUSES.has((command.status ?? "").toLowerCase()) ? "failed" : "passed";
}

export type LedgerInput = {
  sessionId: string;
  finalEvent: { rowId: number; eventId: string | null; text: string } | null;
  commands: CommandRecord[];
  /** Stored event row ID -> `agentops.event.v1` eventId. */
  eventIds: Map<number, string>;
};

/** Pure ledger construction over already-loaded session data. */
export function buildClaimsLedger(input: LedgerInput): ClaimsLedger {
  const { finalEvent } = input;
  const ledger: ClaimsLedger = { sessionId: input.sessionId, finalEventRowId: finalEvent?.rowId ?? null, finalEventId: finalEvent?.eventId ?? null, claims: [] };
  if (!finalEvent) return ledger;

  // Only runs that finished before the final response can back it: never-run
  // and still-running commands are skipped. Commands without an event row keep
  // their place in insertion order.
  const runs = input.commands.filter((command) => {
    const status = (command.status ?? "").toLowerCase();
    return !NOT_EXECUTED_STATUSES.has(status) && !NONTERMINAL_STATUSES.has(status) && (command.eventId === null || command.eventId < finalEvent.rowId);
  });

  for (const rule of evidenceClaimRules) {
    if (!rule.claimPattern.test(finalEvent.text)) continue;
    const evidence = runs
      .filter((command) => rule.commandPattern.test(command.command))
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
    .query("SELECT id, event_uid AS eventUid, summary FROM events WHERE session_id = $sid AND type = 'final_response' ORDER BY idx DESC LIMIT 1")
    .get({ $sid: sessionId }) as { id: number; eventUid: string | null; summary: string } | null;
  const uids = store.db.query("SELECT id, event_uid AS eventUid FROM events WHERE session_id = $sid AND event_uid IS NOT NULL").all({ $sid: sessionId }) as Array<{
    id: number;
    eventUid: string;
  }>;
  return buildClaimsLedger({
    sessionId,
    finalEvent: final ? { rowId: final.id, eventId: final.eventUid, text: final.summary } : null,
    commands: getCommands(store, sessionId),
    eventIds: new Map(uids.map((row) => [row.id, row.eventUid]))
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
