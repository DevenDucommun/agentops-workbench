import { expect, test } from "bun:test";
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
