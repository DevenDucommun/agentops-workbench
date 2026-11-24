import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

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
function measurements(t: Row, start: number, end: number) {
  const steps = new Map<string, Span[]>();
  const tools: Span[] = [], gaps: Span[] = [], outputs: Span[] = [];
  const operations = new Map<number, string>();
  const observed = (a: unknown, b: unknown): Span | undefined => {
    if (!ms(a) || !ms(b) || b < a || b < start || a > end) return;
    return { start: Math.max(start, a), end: Math.min(end, b) };
  };
  function add(label: string, span: Span, all: Span[]) {
    const bucket = steps.get(label) ?? [];
    bucket.push(span);
    steps.set(label, bucket);
    all.push(span);
  }
  let completeTools = true, completeGaps = true, completeOutputs = true;
  for (const item of array(t.tools ?? [])) {
    const tool = row(item);
    const operation = operationFor(tool);
    if (typeof tool.sequence === "number") operations.set(tool.sequence, operation);
    const span = observed(time(tool.startedAt), time(tool.completedAt));
    if (tool.status === "complete" && span) add(`Tool execution: ${operation}`, span, tools);
    else completeTools = false;
    // v1 rollouts usually lack an output timestamp. Completion, a reported
    // nested wall time, and the first model event are different boundaries.
    const output = observed(time(tool.requestedAt), time(tool.firstOutputAt));
    if (output) add(`Tool request to first output: ${operation}`, output, outputs);
    else completeOutputs = false;
  }
  const nextLabels = new Map([["reasoning", "reasoning item"], ["tool", "tool call"], ["message", "message"]]);
  for (const item of array(t.postToolGaps ?? [])) {
    const gap = row(item);
    const next = nextLabels.get(String(gap.nextEvent));
    const span = observed(gap.startMs, gap.endMs);
    if (span && next) add(`After ${operations.get(Number(gap.afterTool)) ?? "tool"} result → ${next}`, span, gaps);
    else completeGaps = false;
  }
  const metrics = new Map([...steps].map(([label, spans]) => [label, summarize(spans)]));
  const reasoningGaps = reasoning(t.reasoningItemGaps);
  if (reasoningGaps?.count) metrics.set("Between same-response reasoning items", reasoningGaps);
  return {
    metrics, reasoningGaps,
    toolExecution: coverage(tools, Array.isArray(t.tools), completeTools),
    afterResult: coverage(gaps, Array.isArray(t.postToolGaps), completeGaps),
    requestToFirstOutput: coverage(outputs, outputs.length > 0, completeOutputs)
  };
}

export function slowTurnReport(input: unknown, hours = 48, minimum = 28, asOf?: string) {
  const source = row(input);
  if (source.schemaVersion !== 1 || !Array.isArray(source.sessions)) throw Error("Expected a v1 Codex timing export with sessions");
  const end = time(asOf ?? source.generatedAt);
  if (end === undefined || !ms(hours) || hours === 0 || !ms(minimum)) throw Error("Invalid report window or minimum duration");
  const start = end - hours * 3_600_000;
  if (!Number.isFinite(new Date(start).getTime())) throw Error("Invalid report window");
  const seen = new Map<string, string>();
  const turns: Turn[] = [];
  const ranked = new Map<string, { step: string; occurrences: number; totalMs: number; longestMs: number; evidence: string[] }>();
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
      const { metrics, ...timing } = measurements(t, from, to);
      turns.push({ evidence, turnIndex: t.turnIndex, startedAt: new Date(from).toISOString(), durationMs: t.durationMs, steps: Array.from(metrics, ([step, measurement]) => ({ step, measurement })), ...timing });
      for (const [step, metric] of metrics) {
        if (metric.totalMs === 0) continue;
        const r = ranked.get(step) ?? { step, occurrences: 0, totalMs: 0, longestMs: 0, evidence: [] };
        r.occurrences += metric.count;
        r.totalMs += metric.totalMs;
        r.longestMs = Math.max(r.longestMs, metric.longestMs);
        r.evidence.push(evidence);
        ranked.set(step, r);
      }
    }
  }
  const steps = [...ranked.values()].map(r => ({ ...r, affectedTurns: r.evidence.length }))
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
  for (const r of report.recurring) lines.push(`- ${r.step}: ${minutes(r.totalMs)} min; ${r.occurrences} occurrences across ${r.affectedTurns} turns. Evidence: ${r.evidence.join(", ")}`);
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
  const usage = "Usage: agentops slow-turns <timing.json|-> [--since-hours 48] [--min-minutes 28] [--as-of ISO-timestamp] [--json]";
  function options() {
    try {
      return parseArgs({ args, allowPositionals: true, options: {
        "since-hours": { type: "string" }, "min-minutes": { type: "string" }, "as-of": { type: "string" }, json: { type: "boolean" }
      } });
    } catch { throw Error(usage); }
  }
  const parsed = options();
  const [file] = parsed.positionals;
  if (!file || parsed.positionals.length !== 1) throw Error(usage);
  const raw = readFileSync(file === "-" ? 0 : file, "utf8");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw Error("Invalid JSON timing export"); }
  const report = slowTurnReport(input, Number(parsed.values["since-hours"] ?? 48), Number(parsed.values["min-minutes"] ?? 28), parsed.values["as-of"]);
  return { stdout: parsed.values.json ? JSON.stringify(report, null, 2) + "\n" : render(report), exitCode: 0 };
}
