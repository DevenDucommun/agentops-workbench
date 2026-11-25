import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseWaitJobs } from "../src/slowTurnWaitJobs";
import { slowTurnReport } from "../src/slowTurns";

const anchor = "2026-01-05T00:00:00Z";
const base = Date.parse("2026-01-04T00:00:00Z");
const iso = (millis: number) => new Date(millis).toISOString();
function turn(turnIndex: number, minutes = 28) {
  const start = base + turnIndex * 3_600_000;
  return { turnIndex, index: turnIndex, status: "complete", startedAt: iso(start), completedAt: iso(start + minutes * 60000),
    durationMs: minutes * 60000, tools: [{ sequence: 1, operation: "test-suite", status: "complete", startedAt: iso(start), completedAt: iso(start + 20000) }],
    postToolGaps: [{ afterTool: 1, nextEvent: "reasoning", startMs: start + 20000, endMs: start + 80000 }],
    reasoningItemGaps: { count: 10, totalMs: 150000, longestMs: 30000 } };
}
function source(...turns: unknown[]) {
  return { schemaVersion: 1, generatedAt: anchor, sessions: [{ session: "private-session-name", interactions: turns }] };
}

test("ranks elapsed steps across distinct qualifying turns with local evidence, including a turn over 40 min", () => {
  const r = slowTurnReport(source(turn(1, 28), turn(2, 45), turn(3, 27), { ...turn(4), status: "aborted" }));
  expect([r.completedTurns, r.qualifiedTurns]).toEqual([3, 2]);
  expect(r.recurring.map(s => s.step)).toEqual(["Between same-response reasoning items", "After test suite result → reasoning item", "Tool execution: test suite"]);
  expect(r.recurring[0]).toMatchObject({ affectedTurns: 2, occurrences: 20, totalMs: 300000, longestMs: 30000,
    evidence: ["/sessions/0/interactions/0", "/sessions/0/interactions/1"] });
});

test("ten gaps within one turn, duplicate session entries and zero time on another turn do not establish recurrence", () => {
  const a = turn(1);
  const b = { ...turn(2), tools: [], postToolGaps: [], reasoningItemGaps: { count: 1, totalMs: 0, longestMs: 0 } };
  const data = source(a, b);
  data.sessions.push(data.sessions[0]);
  const report = slowTurnReport(data);
  expect(report).toMatchObject({ qualifiedTurns: 2, status: "no-recurring-delay", recurring: [] });
  expect(report.turns[0].reasoningGaps?.count).toBe(10);
});

test("counts overlapping spans once for a step, preserves the next event and filters untrusted labels/content", () => {
  const a = turn(1);
  const tools = [{ ...a.tools[0], operation: "private-string", name: "private-string", prompt: "private-string" }];
  const result = slowTurnReport(source({ ...a, tools: [...tools, ...tools], text: "private-string" }));
  expect(result.turns[0].toolExecution).toEqual({ count: 2, totalMs: 20000, longestMs: 20000 });
  expect(result.turns[0].steps.map(s => s.step)).toContain("After unclassified tool result → reasoning item");
  expect(JSON.stringify(result)).not.toContain("private");
});

test("keeps missing boundaries distinct from a measured zero and never substitutes dispatch or reported first-token time", () => {
  const a = turn(1), b = turn(2);
  const result = slowTurnReport(source({ ...a, reasoningItemGaps: null, postToolGaps: undefined,
    reportedTimeToFirstTokenMs: 25, modelDispatchToFirstEventMs: 10000 },
    { ...b, reasoningItemGaps: { count: 0, totalMs: 0, longestMs: 0 }, postToolGaps: [],
      tools: [{ ...b.tools[0], requestedAt: b.startedAt, firstOutputAt: b.startedAt }] }));
  expect(result.turns[0]).toMatchObject({ reasoningGaps: null, requestToFirstOutput: null, afterResult: null });
  expect(result.turns[1]).toMatchObject({ reasoningGaps: { count: 0, totalMs: 0, longestMs: 0 },
    requestToFirstOutput: { count: 1, totalMs: 0 }, afterResult: { count: 0, totalMs: 0 } });
});

test("explicit first-output timing survives another tool with missing timestamps", () => {
  const t = turn(1);
  const tools = [{ ...t.tools[0], requestedAt: t.startedAt, firstOutputAt: iso(Date.parse(t.startedAt) + 500) }, t.tools[0]];
  expect(slowTurnReport(source({ ...t, tools })).turns[0].requestToFirstOutput)
    .toEqual({ count: 1, totalMs: 500, longestMs: 500, partial: true });
});

test("window without qualifying turns excludes earlier, unfinished and future turns", () => {
  const r = slowTurnReport(source(turn(1, 27), turn(-55, 45), turn(25, 45), { ...turn(3), status: "incomplete" }));
  expect(r).toMatchObject({ status: "no-qualifying-turns", completedTurns: 1, qualifiedTurns: 0, recurring: [], turns: [] });
});

test("a separate historical window retains millisecond precision in the reasoning aggregate", () => {
  const a = { ...turn(1), reasoningItemGaps: { count: 53, totalMs: 965624, longestMs: 22959 } };
  const data = { ...source(a), generatedAt: "2026-02-01T00:00:00Z" };
  expect(slowTurnReport(data).qualifiedTurns).toBe(0);
  expect(slowTurnReport(data, 48, 28, anchor).turns[0].reasoningGaps).toEqual(a.reasoningItemGaps);
});

test("groups transitive continuations across each turn, unions overlaps, and caps only the examples", () => {
  function withChain(n: number) {
    const t = turn(n), start = Date.parse(t.startedAt);
    const tool = (sequence: number, parent: number | null, from: number, to: number) => ({
      ...t.tools[0], sequence, continuationOfSequence: parent, executionPhase: parent ? "continuation" : "initial",
      startedAt: iso(start + from), completedAt: iso(start + to)
    });
    return { ...t, tools: [tool(1, null, 0, 100), tool(2, 1, 50, 200), tool(3, 2, 300, 400), tool(4, null, 500, 550)] };
  }
  const input = source(withChain(1), withChain(2));
  const find = (n: number) => slowTurnReport(input, 48, 28, anchor, n).recurring.find(r => r.step === "Tool execution: test suite");
  const r = find(1);
  expect(r).toMatchObject({ totalMs: 700, occurrences: 8, affectedTurns: 2, operationCount: 4, unlinkedRecords: 0 });
  expect(r?.topContributors).toEqual([{ kind: "operation", observedMs: 300, records: 3, initialSequence: 1, evidence: "/sessions/0/interactions/0/tools/0" }]);
  expect(find(5)?.topContributors.length).toBe(4);
});

test("missing targets, ambiguous sequences and cycles never invent an operation or cross turns", () => {
  const a = turn(1), b = turn(2);
  const tools = [ [1, 2], [2, 1], [3, 99], [4, null], [4, null], [5, 4], [6, null] ].map(([sequence, parent]) => ({
    ...a.tools[0], sequence, executionPhase: "cell-wait", continuationOfSequence: parent
  }));
  const r = slowTurnReport(source({ ...a, tools }, { ...b, tools: [{ ...b.tools[0], continuationOfSequence: null, executionPhase: "initial" }] }));
  expect(r.turns[0].waitAttribution).toHaveLength(7);
  expect(r.turns[0].waitAttribution.every(w => w.job === null && w.launch === null)).toBe(true);
  expect(r.turns[1].waitAttribution).toHaveLength(0);
  expect(r.recurring.some(s => s.step.startsWith("Tool execution:"))).toBe(false);
});

test("ranks individual transitions and computes their median from all observations before limiting examples", () => {
  function gaps(n: number, durations: number[]) {
    const t = turn(n);
    const at = Date.parse(t.startedAt);
    return { ...t, tools: [{ ...t.tools[0], continuationOfSequence: null }], postToolGaps: durations.map((duration, i) => ({
      afterTool: 1, nextEvent: "reasoning", startMs: at + i * 10, endMs: at + i * 10 + duration
    })) };
  }
  const r = slowTurnReport(source(gaps(1, [0, 3]), gaps(2, [5, 16])), 48, 28, anchor, 1);
  expect(r.recurring.find(x => x.step.startsWith("After "))).toMatchObject({ medianMs: 4, longestMs: 16,
    topContributors: [{ kind: "transition", initialSequence: 1, sourceSequence: 1, evidence: "/sessions/0/interactions/1/postToolGaps/1", observedMs: 16 }] });
  expect(r.recurring.find(x => x.step.startsWith("Between "))).toMatchObject({ medianMs: null, longestMs: 30000,
    topContributors: [{ kind: "turn summary", records: 10, evidence: "/sessions/0/interactions/0/reasoningItemGaps" }] });
  expect(() => slowTurnReport(source(), 48, 28, anchor, 0)).toThrow("--top");
});

test("job evidence overrides the polling helper and preserves elapsed totals", () => {
  const t = turn(1);
  const tools = [
    { ...t.tools[0], sequence: 1, executionPhase: "initial", continuationOfSequence: null },
    { ...t.tools[0], sequence: 2, executionPhase: "orchestrated", operation: "discovery", continuationOfSequence: null },
    ...[1, 2, 2].map((parent, i) => ({ ...t.tools[0], sequence: i + 3, name: "wait",
      operation: "discovery", executionPhase: "cell-wait", continuationOfSequence: parent }))
  ];
  const input = source({ ...t, tools, postToolGaps: [{ ...t.postToolGaps[0], afterTool: 4 }] });
  const raw = JSON.stringify(input);
  const turnRef = "/sessions/0/interactions/0";
  const job = { turn: turnRef, launchSequence: 1, kind: "review", waitSequences: [4] };
  const file = { schemaVersion: 1, exportSha256: createHash("sha256").update(raw).digest("hex"), jobs: [job] };
  const parse = (jobs: unknown[]) => parseWaitJobs(raw, input, { ...file, jobs });
  const before = slowTurnReport(input).turns[0];
  const after = slowTurnReport(input, 48, 28, anchor, 3, parse([job])).turns[0];
  expect(after.toolExecution).toEqual(before.toolExecution);
  expect(after.afterResult).toEqual(before.afterResult);
  expect(after.waitAttribution.map(w => [w.job, w.basis])).toEqual([
    ["test", "linked operation"], ["review", "supplied"], [null, "unknown"]
  ]);
  expect(after.waitAttribution[1]).toMatchObject({ launch: turnRef + "/tools/0", wait: turnRef + "/tools/3" });
  expect(after.steps.map(s => s.step)).toContain("After wait for review result → reasoning item");
  expect(() => parseWaitJobs(raw + " ", input, file)).toThrow("digest");
  for (const invalid of [[job, job], [{ ...job, waitSequences: [2] }], [{ ...job, launchSequence: 3 }],
    [{ ...job, kind: "private text" }], [{ ...job, turn: "/sessions/0/interactions/1" }]]) {
    expect(() => parse(invalid)).toThrow();
  }
});

test("verified exec polls and cell waits share one job, excluding unverified work and time between polls", () => {
  const t = turn(1);
  const start = Date.parse(t.startedAt);
  const phases = ["initial", "continuation", "cell-wait", "continuation", "orchestrated", "initial"];
  const tools = phases.map((phase, i) => ({ ...t.tools[0], name: phase === "cell-wait" ? "wait" : "exec",
    sequence: i + 1, operation: "other", executionPhase: phase, continuationOfSequence: i || null,
    startedAt: iso(start + i * 200), completedAt: iso(start + i * 200 + 100) }));
  const input = source({ ...t, tools, postToolGaps: [{ ...t.postToolGaps[0], afterTool: 2 }] });
  const raw = JSON.stringify(input);
  const job = { turn: "/sessions/0/interactions/0", launchSequence: 1, kind: "review" };
  const links = (waitSequences: number[]) => parseWaitJobs(raw, input, { schemaVersion: 1,
    exportSha256: createHash("sha256").update(raw).digest("hex"), jobs: [{ ...job, waitSequences }] });
  const before = slowTurnReport(input).turns[0];
  const after = slowTurnReport(input, 48, 28, anchor, 3, links([2, 3])).turns[0];
  expect(after.waitAttribution).toHaveLength(2);
  expect(after.waitAttribution.every(w => w.basis === "supplied" && w.launch === job.turn + "/tools/0")).toBe(true);
  expect(after.steps.find(s => s.step === "Tool execution: wait for review")?.measurement)
    .toEqual({ count: 2, totalMs: 200, longestMs: 100 });
  expect(after.steps.find(s => s.step === "Tool execution: execution continuation")?.measurement.count).toBe(1);
  expect(after.steps.some(s => s.step === "After wait for review result → reasoning item")).toBe(true);
  expect(after.toolExecution).toEqual(before.toolExecution);
  expect(after.afterResult).toEqual(before.afterResult);
  for (const invalid of [[5], [6], [2, 2]]) expect(() => links(invalid)).toThrow();
});
