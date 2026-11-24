import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Detail, type Observation, toolOrigins, toolDetail, transitionDetail, topContributors } from "./slowTurnContributors";

// Only copy timing fields and controlled vocabulary from the PAI v1 export.
// JSON pointers locate the original interaction without copying session paths,
// prompts, arguments, or arbitrary tool names into a report.
type Row = Record<string, unknown>;
type Span = { start: number; end: number };
type Metric = { count: number; totalMs: number; longestMs: number; partial?: true };
type Turn = {
  evidence: string;
  turnIndex: number;
  startedAt: string;
  durationMs: number;
  toolExecution: Metric | null;
  afterResult: Metric | null;
  reasoningGaps: Metric | null;
  requestToFirstOutput: Metric | null;
  steps: { step: string; measurement: Metric }[];
};
const row = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid accounting record");
  return value as Row;
};
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Expected an accounting array");
  return value;
}
const ms = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function time(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : undefined;
}
const labels = new Map(Object.entries({
  matrix: "matrix", preflight: "preflight", "test-suite": "test suite", telemetry: "telemetry",
  "ci-wait": "CI wait", "github-read": "GitHub read", "github-write": "GitHub write", git: "Git",
  generator: "generator", patch: "patch", discovery: "discovery", other: "other"
}));
const phases = new Map(Object.entries({
  initial: "initial execution", continuation: "execution continuation", "cell-wait": "execution wait",
  orchestrated: "orchestrated execution"
}));
const otherTools = new Map(Object.entries({
  exec: "execution", wait: "execution wait", sleep: "sleep", wait_agent: "agent wait",
  spawn_agent: "agent launch", followup_task: "agent follow-up", send_message: "agent message"
}));
function operationFor(tool: Row): string {
  const category = labels.get(String(tool.operation));
  if (category && category !== "other") return category;
  return phases.get(String(tool.executionPhase)) ?? otherTools.get(String(tool.name)) ?? "unclassified tool";
}
function summarize(spans: Span[]): Metric {
  let end = -Infinity, totalMs = 0, longestMs = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    totalMs += Math.max(0, span.end - Math.max(span.start, end));
    longestMs = Math.max(longestMs, span.end - span.start);
    end = Math.max(end, span.end);
  }
  return { count: spans.length, totalMs, longestMs };
}
function coverage(spans: Span[], supplied: boolean, complete: boolean): Metric | null {
  if (!supplied || (!complete && !spans.length)) return null;
  return complete ? summarize(spans) : { ...summarize(spans), partial: true };
}
function reasoning(value: unknown): Metric | null {
  if (value == null) return null;
  const { count, longestMs, totalMs } = row(value);
  if (!ms(count) || !Number.isSafeInteger(count) || !ms(totalMs) || !ms(longestMs) ||
      longestMs > totalMs || totalMs > count * longestMs) throw Error("Invalid reasoning gap measurements");
  return { count, totalMs, longestMs };
}
function measurements(t: Row, start: number, end: number, evidence: string) {
  const steps = new Map<string, Observation[]>();
  const details = new Map<string, Detail>();
  const tools: Span[] = [], gaps: Span[] = [], outputs: Span[] = [];
  const operations = new Map<number, string>();
  const observed = (a: unknown, b: unknown): Span | undefined => {
    if (!ms(a) || !ms(b) || b < a || b < start || a > end) return;
    return { start: Math.max(start, a), end: Math.min(end, b) };
  };
  function add(label: string, span: Observation, all: Span[]) {
    const bucket = steps.get(label) ?? [];
    bucket.push(span);
    steps.set(label, bucket);
    all.push(span);
  }
  let completeTools = true, completeGaps = true, completeOutputs = true;
  const records = array(t.tools ?? []).map(row);
  const origins = toolOrigins(records, evidence);
  for (const [i, tool] of records.entries()) {
    const ref = { evidence: `${evidence}/tools/${i}`, origin: typeof tool.sequence === "number" ? origins.get(tool.sequence) : undefined,
      sequence: typeof tool.sequence === "number" ? tool.sequence : undefined };
    const operation = operationFor(tool);
    if (typeof tool.sequence === "number") operations.set(tool.sequence, operation);
    const span = observed(time(tool.startedAt), time(tool.completedAt));
    if (tool.status === "complete" && span) add(`Tool execution: ${operation}`, { ...span, ...ref }, tools);
    else completeTools = false;
    // v1 rollouts usually lack an output timestamp. Completion, a reported
    // nested wall time, and the first model event are different boundaries.
    const output = observed(time(tool.requestedAt), time(tool.firstOutputAt));
    if (output) add(`Tool request to first output: ${operation}`, { ...output, ...ref }, outputs);
    else completeOutputs = false;
  }
  const nextLabels = new Map([["reasoning", "reasoning item"], ["tool", "tool call"], ["message", "message"]]);
  for (const [i, item] of array(t.postToolGaps ?? []).entries()) {
    const gap = row(item);
    const next = nextLabels.get(String(gap.nextEvent));
    const span = observed(gap.startMs, gap.endMs);
    if (span && next) add(`After ${operations.get(Number(gap.afterTool)) ?? "tool"} result → ${next}`, { ...span, evidence: `${evidence}/postToolGaps/${i}`,
      sequence: typeof gap.afterTool === "number" ? gap.afterTool : undefined, origin: origins.get(Number(gap.afterTool)) }, gaps);
    else completeGaps = false;
  }
  const metrics = new Map([...steps].map(([label, spans]) => [label, summarize(spans)]));
  for (const [label, spans] of steps) {
    details.set(label, label.startsWith("Tool execution:") ? toolDetail(spans, group => summarize(group).totalMs) : transitionDetail(spans));
  }
  const reasoningGaps = reasoning(t.reasoningItemGaps);
  if (reasoningGaps?.count) {
    const label = "Between same-response reasoning items";
    metrics.set(label, reasoningGaps);
    details.set(label, { contributors: [{ kind: "turn summary", evidence: evidence + "/reasoningItemGaps",
      observedMs: reasoningGaps.totalMs, records: reasoningGaps.count }], durations: [] });
  }
  return {
    metrics, details, reasoningGaps,
    toolExecution: coverage(tools, Array.isArray(t.tools), completeTools),
    afterResult: coverage(gaps, Array.isArray(t.postToolGaps), completeGaps),
    requestToFirstOutput: coverage(outputs, outputs.length > 0, completeOutputs)
  };
}

export function slowTurnReport(input: unknown, hours = 48, minimum = 28, asOf?: string, top = 3) {
  if (!Number.isSafeInteger(top) || top < 1) throw Error("--top must be a positive integer");
  const source = row(input);
  if (source.schemaVersion !== 1 || !Array.isArray(source.sessions)) throw Error("Expected a v1 Codex timing export with sessions");
  const end = time(asOf ?? source.generatedAt);
  if (end === undefined || !ms(hours) || hours === 0 || !ms(minimum)) throw Error("Invalid report window or minimum duration");
  const start = end - hours * 3_600_000;
  if (!Number.isFinite(new Date(start).getTime())) throw Error("Invalid report window");
  const seen = new Map<string, string>();
  const turns: Turn[] = [];
  const ranked = new Map<string, { step: string; occurrences: number; totalMs: number; longestMs: number; evidence: string[]; details: Detail[] }>();
  let longestCompletedMs: number | null = null;
  for (const [si, entry] of source.sessions.entries()) {
    const session = row(entry);
    if (typeof session.session !== "string" || !session.session) throw Error("Missing accounting session identity");
    for (const [ti, item] of array(session.interactions).entries()) {
      const t = row(item);
      if (t.status !== "complete") continue;
      const from = time(t.startedAt), to = time(t.completedAt);
      if (from === undefined || to === undefined || to < from || !ms(t.durationMs) || typeof t.turnIndex !== "number" || !Number.isSafeInteger(t.turnIndex)) throw Error("Invalid completed turn");
      if (from < start || to > end) continue;
      const key = JSON.stringify([session.session, t.turnIndex]);
      const boundaries = JSON.stringify([from, to, t.durationMs]);
      const previous = seen.get(key);
      if (previous !== undefined) {
        if (previous !== boundaries) throw Error("Conflicting completed interactions for the same session and turn");
        continue;
      }
      seen.set(key, boundaries);
      longestCompletedMs = Math.max(longestCompletedMs ?? 0, t.durationMs);
      if (t.durationMs < minimum * 60_000) continue;
      const evidence = `/sessions/${si}/interactions/${ti}`;
      const { metrics, details, ...timing } = measurements(t, from, to, evidence);
      turns.push({ evidence, turnIndex: t.turnIndex, startedAt: new Date(from).toISOString(), durationMs: t.durationMs, steps: Array.from(metrics, ([step, measurement]) => ({ step, measurement })), ...timing });
      for (const [step, metric] of metrics) {
        if (metric.totalMs === 0) continue;
        const r = ranked.get(step) ?? { step, occurrences: 0, totalMs: 0, longestMs: 0, evidence: [], details: [] };
        r.occurrences += metric.count;
        r.totalMs += metric.totalMs;
        r.longestMs = Math.max(r.longestMs, metric.longestMs);
        r.evidence.push(evidence);
        const detail = details.get(step);
        if (detail) r.details.push(detail);
        ranked.set(step, r);
      }
    }
  }
  const steps = [...ranked.values()].map(({ details, ...r }) => ({ ...r, affectedTurns: r.evidence.length, ...topContributors(details, top) }))
    .sort((a, b) => b.totalMs - a.totalMs || a.step.localeCompare(b.step));
  const recurring = steps.filter(r => r.affectedTurns >= 2 && r.totalMs > 0);
  return { windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(), minMinutes: minimum,
    completedTurns: seen.size, qualifiedTurns: turns.length, longestCompletedMs,
    status: !turns.length ? "no-qualifying-turns" : recurring.length ? "recurring-delays" : "no-recurring-delay",
    recurring, turns };
}

const minutes = (value: number) => (value / 60_000).toFixed(2);
function render(report: ReturnType<typeof slowTurnReport>): string {
  const lines = [`Window: ${report.windowStart} through ${report.windowEnd}`,
    `Completed turns examined: ${report.completedTurns}. Qualified (at least ${report.minMinutes} min): ${report.qualifiedTurns}.`];
  if (report.longestCompletedMs !== null) lines.push(`Longest completed turn: ${minutes(report.longestCompletedMs)} min.`);
  if (!report.qualifiedTurns) return lines.concat("No qualifying turns.").join("\n") + "\n";
  lines.push("", report.recurring.length ? "Recurring delays by observed turn-minutes" : "No recurring delay observed across distinct qualifying turns.");
  for (const r of report.recurring) {
    lines.push(`- ${r.step}: ${minutes(r.totalMs)} min; ${r.occurrences} occurrences across ${r.affectedTurns} turns. Evidence: ${r.evidence.join(", ")}`);
    if (r.operationCount || r.unlinkedRecords) lines.push(`  ${r.operationCount} linked or standalone operations; ${r.unlinkedRecords} records with unknown origin.`);
    if (r.topContributors[0]?.kind === "turn summary") lines.push(`  Median unavailable from turn summaries; longest ${(r.longestMs / 1000).toFixed(3)} s.`);
    if (r.medianMs !== null) lines.push(`  Median ${(r.medianMs / 1000).toFixed(3)} s; longest ${(r.longestMs / 1000).toFixed(3)} s.`);
    for (const c of r.topContributors) {
      const root = c.initialSequence === undefined ? "" : ` · initial #${c.initialSequence}`;
      const source = c.sourceSequence === undefined ? "" : ` · from #${c.sourceSequence}`;
      lines.push(`  ${minutes(c.observedMs)} min · ${c.kind}${root}${source} · ${c.records} observations · ${c.evidence}`);
    }
  }
  lines.push("", "Per-turn timings (JSON pointers into the supplied export)");
  for (const t of report.turns) {
    lines.push(`${t.evidence} · turn ${t.turnIndex} · ${t.startedAt} · ${minutes(t.durationMs)} min`);
    for (const [name, metric] of [["Tool execution", t.toolExecution], ["After tool result", t.afterResult],
      ["Same-response reasoning gaps", t.reasoningGaps], ["Tool request to first output", t.requestToFirstOutput]] as const) {
      lines.push(`  ${name}: ${metric ? `${metric.count} observed, ${minutes(metric.totalMs)} min total, ${(metric.longestMs / 1000).toFixed(3)} s longest${metric.partial ? " (partial timing)" : ""}` : "timing unavailable"}`);
    }
    for (const { step, measurement } of t.steps) {
      if (step.startsWith("After ") || step.startsWith("Tool execution:")) {
        lines.push(`    ${step}: ${measurement.count} observed, ${minutes(measurement.totalMs)} min`);
      }
    }
  }
  lines.push("Overlapping spans are counted once per step and turn. Rows can overlap and should not be added. Gaps are elapsed time between recorded events.");
  return lines.join("\n") + "\n";
}

export function runSlowTurns(args: string[]) {
  const usage = "Usage: agentops slow-turns <timing.json|-> [--since-hours 48] [--min-minutes 28] [--as-of ISO-timestamp] [--top 3] [--json]";
  function options() {
    try {
      return parseArgs({ args, allowPositionals: true, options: {
        "since-hours": { type: "string" }, "min-minutes": { type: "string" }, "as-of": { type: "string" }, top: { type: "string" }, json: { type: "boolean" }
      } });
    } catch { throw Error(usage); }
  }
  const parsed = options();
  const [file] = parsed.positionals;
  if (!file || parsed.positionals.length !== 1) throw Error(usage);
  const raw = readFileSync(file === "-" ? 0 : file, "utf8");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw Error("Invalid JSON timing export"); }
  const report = slowTurnReport(input, Number(parsed.values["since-hours"] ?? 48), Number(parsed.values["min-minutes"] ?? 28), parsed.values["as-of"], Number(parsed.values.top ?? 3));
  return { stdout: parsed.values.json ? JSON.stringify(report, null, 2) + "\n" : render(report), exitCode: 0 };
}
