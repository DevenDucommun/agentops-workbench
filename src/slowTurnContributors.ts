// All pointers address the supplied timing export. Keep labels and numeric
// metadata only: tool arguments and tool results never enter this projection.
type Row = Record<string, unknown>;
type Origin = { sequence: number; evidence: string };
export type Observation = {
  start: number; end: number; evidence: string; origin?: Origin; sequence?: number;
};
type Contributor = {
  kind: "operation" | "unlinked record" | "transition" | "turn summary";
  evidence: string; initialSequence?: number; sourceSequence?: number;
  records: number; observedMs: number;
};
export type Detail = { contributors: Contributor[]; durations: number[] };

export function toolOrigins(tools: Row[], turn: string) {
  const entries = new Map<number, { tool: Row; evidence: string }>();
  const duplicates = new Set<number>();
  for (const [i, tool] of tools.entries()) {
    const n = tool.sequence;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) continue;
    if (entries.has(n)) duplicates.add(n);
    entries.set(n, { tool, evidence: `${turn}/tools/${i}` });
  }
  const origins = new Map<number, Origin>();
  for (const n of [...entries.keys()].sort((a, b) => a - b)) {
    const entry = entries.get(n);
    if (!entry || duplicates.has(n)) continue;
    const parent = entry.tool.continuationOfSequence;
    if (parent === null && entry.tool.executionPhase !== "cell-wait" && entry.tool.executionPhase !== "continuation") {
      origins.set(n, { sequence: n, evidence: entry.evidence });
    } else if (typeof parent === "number" && parent < n) {
      const origin = origins.get(parent);
      if (origin) origins.set(n, origin);
    }
  }
  return origins;
}

// One linked operation may have overlapping records. Use the same union as
// the ranked step. An operation's contribution measures only that step's spans.
export function toolDetail(spans: Observation[], total: (spans: Observation[]) => number): Detail {
  const groups = new Map<string, Observation[]>();
  for (const span of spans) {
    const key = span.origin?.evidence ?? span.evidence;
    const group = groups.get(key) ?? [];
    group.push(span);
    groups.set(key, group);
  }
  const contributors: Contributor[] = [];
  for (const [evidence, group] of groups) {
    const origin = group[0].origin;
    contributors.push({ kind: origin ? "operation" : "unlinked record", evidence, initialSequence: origin?.sequence,
      records: group.length, observedMs: total(group) });
  }
  return { contributors, durations: [] };
}

export function transitionDetail(spans: Observation[]): Detail {
  return {
    contributors: spans.map(s => ({ kind: "transition", evidence: s.evidence, sourceSequence: s.sequence,
      initialSequence: s.origin?.sequence, records: 1, observedMs: s.end - s.start })),
    durations: spans.map(s => s.end - s.start)
  };
}

export function topContributors(details: Detail[], top: number) {
  const contributors = details.flatMap(d => d.contributors);
  const durations = details.flatMap(d => d.durations).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const medianMs = durations.length ? (durations[mid] + durations[Math.floor((durations.length - 1) / 2)]) / 2 : null;
  const operationCount = contributors.filter(c => c.kind === "operation").length;
  const unlinkedRecords = contributors.filter(c => c.kind === "unlinked record").length;
  contributors.sort((a, b) => b.observedMs - a.observedMs || a.evidence.localeCompare(b.evidence));
  return { operationCount, unlinkedRecords, medianMs, topContributors: contributors.slice(0, top) };
}
