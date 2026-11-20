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

/**
 * Whether the final response makes this rule's claim. Claims are found per
 * clause: sentences, contrastive clauses, and coordinated clauses that carry
 * their own verdict word ("Tests failed and lint passed" claims lint only;
 * "Tests and lint passed" claims both). A negated success word ("did not
 * pass", "aren't passing") is not a claim.
 */
export function claimsRule(rule: Pick<EvidenceClaimRule, "claimPattern">, text: string): boolean {
  return claimClauses(text).some((clause) => rule.claimPattern.test(clause.replace(NEGATED_SUCCESS, " negated ")));
}

const VERDICT_WORD = /\b(?:pass(?:ed|es|ing)?|fail(?:ed|s|ing|ures?)?|green|clean|broken|succeed(?:ed|s)?|success(?:ful)?|verified|complete(?:d)?|errors?)\b/i;
const NEGATED_SUCCESS =
  /\b(?:not|never|no longer|cannot|\w+n['’]t)\s+(?:\w+\s+){0,2}?(?:pass(?:ed|es|ing)?|green|clean|succeed(?:ed|s)?|successful|verified|complete(?:d)?)\b/gi;

function claimClauses(text: string): string[] {
  return text
    .split(/[.!?;](?=\s|$)|\n+|,?\s+(?:but|whereas|although|though|however|yet)\b/i)
    .flatMap(coordinatedClauses)
    .filter((clause) => clause.trim().length > 0);
}

/** Splits a sentence at `,` / `and` only where each side has its own verdict word. */
function coordinatedClauses(sentence: string): string[] {
  const clauses: string[] = [];
  let pending = "";
  for (const part of sentence.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)) {
    pending = pending ? `${pending} and ${part}` : part;
    if (VERDICT_WORD.test(pending)) {
      clauses.push(pending);
      pending = "";
    }
  }
  if (pending) {
    if (clauses.length > 0) clauses[clauses.length - 1] += ` and ${pending}`;
    else clauses.push(pending);
  }
  return clauses;
}

type RunOutcome = "passed" | "failed" | "unknown";

/**
 * Whether `command` executes this rule's verification command, as opposed to
 * merely mentioning it (`rg 'bun test' README.md`) or looking it up
 * (`command -v bun`). The pattern must match at the program position of a
 * shell segment, after env assignments and runner wrappers (with their option
 * operands); `sh -c '<script>'` is unwrapped.
 */
export function runsRuleCommand(rule: Pick<EvidenceClaimRule, "commandPattern">, command: string): boolean {
  return ruleRunOutcomes(rule, command, "unknown", 0).length > 0;
}

/**
 * The outcome of this rule's command inside `command`, given the shell's single
 * aggregate outcome, or null when `command` does not run it. The aggregate is
 * attributed to the verification segment only when it is that segment's own
 * result: a lone command, the last command after `;`, the last command after
 * setup-only steps (`cd dir && bun test`), or an all-`&&` chain that passed.
 * Anything else (`bun test; true`, `true || bun test`, `bun test | tail`) is
 * `unknown`, which is not evidence.
 */
function ruleRunOutcome(rule: Pick<EvidenceClaimRule, "commandPattern">, command: string, aggregate: "passed" | "failed"): RunOutcome | null {
  const outcomes = ruleRunOutcomes(rule, command, aggregate, 0);
  if (outcomes.length === 0) return null;
  if (outcomes.includes("failed")) return "failed";
  return outcomes.every((outcome) => outcome === "passed") ? "passed" : "unknown";
}

function ruleRunOutcomes(rule: Pick<EvidenceClaimRule, "commandPattern">, command: string, aggregate: RunOutcome, depth: number): RunOutcome[] {
  const anchored = new RegExp(`^(?:${rule.commandPattern.source})`, rule.commandPattern.flags.replace(/[gy]/g, ""));
  const segments = shellSegments(command);
  const outcomes: RunOutcome[] = [];
  segments.forEach((segment, index) => {
    const words = stripWrappers(shellWords(segment.text));
    if (!words || words.length === 0) return;
    const own = aggregate === "unknown" ? "unknown" : segmentOutcome(segments, index, aggregate);
    const program = basename(words[0]);
    if (SHELL_PROGRAM.test(program) && depth < 3) {
      const flag = words.findIndex((word, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(word));
      if (flag > 0 && words[flag + 1] !== undefined) {
        outcomes.push(...ruleRunOutcomes(rule, words[flag + 1], own, depth + 1));
        return;
      }
    }
    if (anchored.test([program, ...words.slice(1)].join(" "))) outcomes.push(own);
  });
  return outcomes;
}

const SETUP_PROGRAMS = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "true", ":", "echo", "printf", "shopt", "ulimit", "umask", "alias"]);

function segmentOutcome(segments: ShellSegment[], index: number, aggregate: "passed" | "failed"): RunOutcome {
  if (segments.length === 1) return aggregate;
  if (segments.slice(1).some((segment) => segment.op !== "&&" && segment.op !== ";")) return "unknown";
  // The shell's exit code is the last `;` group's; earlier groups' codes are lost.
  let groupStart = 0;
  for (let i = 1; i < segments.length; i++) if (segments[i].op === ";") groupStart = i;
  if (index < groupStart) return "unknown";
  // An `&&` group that passed ran every command, and each one passed.
  if (aggregate === "passed") return "passed";
  const setupOnlyBefore = segments.slice(groupStart, index).every((segment) => SETUP_PROGRAMS.has(basename(shellWords(segment.text)[0] ?? "")));
  return index === segments.length - 1 && setupOnlyBefore ? "failed" : "unknown";
}

const SHELL_PROGRAM = /^(?:ba|z|da|k|fi)?sh$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type WrapperSpec = {
  /** Options whose value is the next word. */
  operands?: string[];
  /** Options whose value is a command string to run. */
  script?: string[];
  /** Options that only look the command up. */
  lookup?: RegExp;
  /** Positional operands before the wrapped command (timeout's duration). */
  positional?: number;
};

const WRAPPERS: Record<string, WrapperSpec> = {
  env: { operands: ["-u", "--unset", "-C", "--chdir", "-P"], script: ["-S", "--split-string"] },
  timeout: { operands: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  nice: { operands: ["-n", "--adjustment"] },
  nohup: {},
  time: { operands: ["-f", "--format", "-o", "--output"] },
  command: { lookup: /^-[pvV]*[vV][pvV]*$/ },
  exec: { operands: ["-a"] },
  sudo: { operands: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"] },
  npx: { operands: ["-p", "--package", "-w", "--workspace"], script: ["-c", "--call"] },
  bunx: { operands: ["-p", "--package"] },
  pnpx: { operands: ["--package"] },
  "xvfb-run": { operands: ["-n", "--server-num", "-s", "--server-args", "-f", "--auth-file", "-e", "--error-file", "-w", "--wait", "-p", "--xauth-protocol"] },
  "npm exec": { operands: ["-p", "--package", "-w", "--workspace"], script: ["-c", "--call"] },
  "pnpm exec": { operands: ["-F", "--filter", "-C", "--dir"] },
  "pnpm dlx": { operands: ["--package"] },
  "yarn exec": {},
  "yarn dlx": { operands: ["-p", "--package"] },
  "uv run": { operands: ["--with", "--with-requirements", "--python", "-p", "--directory", "--project", "--env-file", "--extra", "--group", "--package", "--index"] },
  "poetry run": { operands: ["-C", "--directory", "-P", "--project"] },
  "pipenv run": {},
  "python -m": {},
  "python3 -m": {}
};

/**
 * Drops leading env assignments and runner wrappers with their options and
 * option operands. Returns null when the wrapper only looks the command up.
 */
function stripWrappers(input: string[]): string[] | null {
  let words = input;
  for (;;) {
    if (words.length === 0) return words;
    if (ASSIGNMENT.test(words[0])) {
      words = words.slice(1);
      continue;
    }
    const program = basename(words[0]);
    const pair = `${program} ${words[1] ?? ""}`;
    const spec = WRAPPERS[pair] ?? WRAPPERS[program];
    if (!spec) return words;
    words = words.slice(WRAPPERS[pair] ? 2 : 1);
    let positional = spec.positional ?? 0;
    while (words.length > 0) {
      const word = words[0];
      if (word === "--") {
        words = words.slice(1);
        break;
      }
      if (spec.lookup?.test(word)) return null;
      const [name, inline] = word.startsWith("--") ? word.split(/=(.*)/s) : [word, undefined];
      if (spec.script?.includes(name)) {
        const script = inline ?? words[1];
        if (script === undefined) return [];
        words = [...shellWords(script), ...words.slice(inline === undefined ? 2 : 1)];
        positional = 0;
        break;
      }
      if (word.startsWith("-")) {
        words = words.slice(spec.operands?.includes(name) && inline === undefined ? 2 : 1);
      } else if (program === "env" && ASSIGNMENT.test(word)) {
        words = words.slice(1);
      } else if (positional > 0) {
        words = words.slice(1);
        positional--;
      } else {
        break;
      }
    }
  }
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

type ShellSegment = { text: string; op: string | null };

/**
 * Splits a shell command on unquoted `&&`, `||`, `|`, `|&`, `&`, `;` and newlines
 * (newline counts as `;`), recording the operator before each segment.
 * Redirections such as `2>&1` and `&>file` stay inside their segment;
 * parentheses are treated as whitespace.
 */
function shellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current = "";
  let op: string | null = null;
  let quote: string | null = null;
  const cut = (next: string) => {
    if (current.trim() === "" && next === ";") return;
    segments.push({ text: current.trim(), op });
    current = "";
    op = next;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];
    if (quote) {
      if (char === "\\" && quote === '"' && nextChar !== undefined) {
        current += char + command[++i];
        continue;
      }
      if (char === quote) quote = null;
      current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "\\" && nextChar !== undefined) {
      current += char + command[++i];
    } else if (char === "(" || char === ")") {
      current += " ";
    } else if (char === "&" && (/[<>]$/.test(current) || nextChar === ">")) {
      current += char;
    } else if (char === "&") {
      if (nextChar === "&") i++;
      cut(nextChar === "&" ? "&&" : "&");
    } else if (char === "|" && /[>]$/.test(current)) {
      current += char;
    } else if (char === "|") {
      if (nextChar === "|" || nextChar === "&") i++;
      cut(nextChar === "|" ? "||" : "|");
    } else if (char === ";" || char === "\n") {
      cut(";");
    } else {
      current += char;
    }
  }
  if (current.trim() !== "" || (op !== null && op !== ";")) segments.push({ text: current.trim(), op });
  return segments.filter((segment, index) => segment.text !== "" || index > 0);
}

/** Splits one segment into words, removing quotes; a quoted argument stays one word. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < segment.length) current += segment[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

const NOT_EXECUTED_STATUSES = new Set(["inferred", "denied", "declined"]);
/**
 * A run that started but has not reported a result (e.g. Codex `item.started`)
 * proves nothing yet, nor does one whose result was never recorded (a Claude
 * Code tool_use with no matching tool_result: `no_result`).
 */
const NONTERMINAL_STATUSES = new Set(["in_progress", "started", "running", "pending", "queued", "no_result"]);
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
    if (!claimsRule(rule, finalEvent.text)) continue;
    // A run whose verification segment's own outcome is unknown (e.g. `bun test; true`) is not evidence.
    const evidence = runs.flatMap((command): LedgerEvidence[] => {
      const outcome = ruleRunOutcome(rule, command.command, commandOutcome(command));
      if (outcome === null || outcome === "unknown") return [];
      return [
        {
          eventRowId: command.eventId,
          eventId: command.eventId === null ? null : (input.eventIds.get(command.eventId) ?? null),
          command: command.command,
          status: command.status,
          exitCode: command.exitCode,
          outcome
        }
      ];
    });
    const cited = evidence.at(-1) ?? null;
    ledger.claims.push({ id: rule.id, label: rule.label, category: rule.category, verdict: verdictFor(cited), reason: reasonFor(rule.label, cited, evidence.length), evidence, cited });
  }
  return ledger;
}

/** Ledger for a stored session's latest final response. */
export function getClaimsLedger(store: Store, sessionId: string): ClaimsLedger {
  const final = store.db
    // Full final response when the store saved one (events.text), else the display summary (legacy rows).
    .query("SELECT id, event_uid AS eventUid, COALESCE(text, summary) AS text FROM events WHERE session_id = $sid AND type = 'final_response' ORDER BY idx DESC LIMIT 1")
    .get({ $sid: sessionId }) as { id: number; eventUid: string | null; text: string } | null;
  const uids = store.db.query("SELECT id, event_uid AS eventUid FROM events WHERE session_id = $sid AND event_uid IS NOT NULL").all({ $sid: sessionId }) as Array<{
    id: number;
    eventUid: string;
  }>;
  return buildClaimsLedger({
    sessionId,
    finalEvent: final ? { rowId: final.id, eventId: final.eventUid, text: final.text } : null,
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
