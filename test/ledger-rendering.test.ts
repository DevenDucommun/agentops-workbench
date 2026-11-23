import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveAdapter } from "../src/adapters";
import { analyzeSession } from "../src/analyzer";
import { evaluateQualityGate, formatGateGithub } from "../src/gate";
import { defaultConfig } from "../src/config";
import { getDashboardSession } from "../src/dashboardData";
import { parseJsonlTranscript } from "../src/parser";
import { generateGithubRepoComment, generateMarkdownReport } from "../src/report";
import { ingestTranscript, openStore, type Store } from "../src/store";

const ROOT = join(import.meta.dir, "..");

function withSession<T>(fixture: string, use: (store: Store, sessionId: string) => T): T {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-ledger-render-")), "agentops.db"));
  const path = isAbsolute(fixture) ? fixture : join(ROOT, fixture);
  const { sessionId } = ingestTranscript(store, parseJsonlTranscript(path, readFileSync(path, "utf8")), defaultConfig);
  analyzeSession(store, sessionId, defaultConfig);
  try {
    return use(store, sessionId);
  } finally {
    store.db.close();
  }
}

const section = (text: string, heading: string, next: string) => text.slice(text.indexOf(heading), text.indexOf(next, text.indexOf(heading)));

describe("session report (spec R2.5)", () => {
  test("lists each claim with its verdict and the timeline step it rests on", () => {
    const report = withSession("fixtures/ledger/fail-then-pass-then-claim.jsonl", (store, sid) => generateMarkdownReport(store, sid));
    expect(section(report, "## Claims Ledger", "## Risk Flags").trim()).toBe(
      [
        "## Claims Ledger",
        "",
        "| Claim | Verdict | Evidence |",
        "| --- | --- | --- |",
        "| test | Supported | `bun test` (exit 0), [step 4](#event-step-4) (evt-0002-test-pass) |"
      ].join("\n")
    );
    expect(report).toContain('- <a id="event-step-4"></a>4. **tool_call**');
  });

  test("contradicted and unsupported claims say so", () => {
    const contradicted = withSession("fixtures/ledger/fail-then-claim.jsonl", (store, sid) => generateMarkdownReport(store, sid));
    expect(contradicted).toContain("| test | Contradicted | `bun test` (exit 1), [step 3](#event-step-3) |");
    const unsupported = withSession("fixtures/ledger/no-run-then-claim.jsonl", (store, sid) => generateMarkdownReport(store, sid));
    expect(unsupported).toContain("| test | Unsupported | No observed test command ran before the final response. |");
  });

  test("a final response without claims gets no ledger section", () => {
    const report = withSession("fixtures/stalls/retry-loop.jsonl", (store, sid) => generateMarkdownReport(store, sid));
    expect(report).not.toContain("## Claims Ledger");
  });
});

describe("PR comment", () => {
  test("includes the claims table", () => {
    const comment = withSession("fixtures/ledger/fail-then-claim.jsonl", (store, sid) => generateGithubRepoComment(store, sid, []));
    expect(section(comment, "### Claims", "### Risk Flags")).toContain("| test | Contradicted | `bun test` (exit 1), step 3 |");
  });
});

describe("dashboard evidence rows", () => {
  const evidence = (fixture: string) => withSession(fixture, (store, sid) => getDashboardSession(store, sid, defaultConfig)?.decision);

  test("a contradicted claim shows as contradicted and needs review", () => {
    const decision = evidence("fixtures/ledger/fail-then-claim.jsonl");
    expect(decision?.evidence.find((row) => row.id === "test")).toMatchObject({ status: "contradicted", command: "bun test", commandExitCode: 1, riskCategory: "contradicted-claim" });
    expect(decision?.evidence.find(row => row.id === "final-success")).toMatchObject({ status: "contradicted", eventStep: 3 });
    expect(decision?.mergeReadiness.status).toBe("needs-review");
    expect(decision?.mergeReadiness.reasons).toContain("1 claimed check is contradicted by a failing run.");
  });

  test("a supported claim cites the passing run, not the earlier failure", () => {
    const decision = evidence("fixtures/ledger/fail-then-pass-then-claim.jsonl");
    expect(decision?.evidence.find((row) => row.id === "test")).toMatchObject({ status: "verified", command: "bun test", commandExitCode: 0, eventStep: 4 });
  });

  test("a test that ran only after the final claim is unsupported on both surfaces", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentops-ledger-render-")), "late-run.jsonl");
    writeFileSync(
      path,
      [
        { type: "session", id: "ledger-late-run", agent: "synthetic-agent" },
        { type: "final_response", role: "assistant", content: "Tests passed." },
        { type: "tool_call", toolName: "Bash", input: { cmd: "bun test" }, status: "completed", exitCode: 0 }
      ]
        .map((record) => JSON.stringify({ schemaVersion: "agentops.event.v1", ...record }))
        .join("\n")
    );
    const [report, decision] = withSession(path, (store, sid) => [generateMarkdownReport(store, sid), getDashboardSession(store, sid, defaultConfig)?.decision] as const);
    expect(report).toContain("| test | Unsupported |");
    expect(decision?.mergeReadiness.missingEvidenceCount).toBe(1);
    expect(decision?.evidence.find(row => row.id === "final-success")).toMatchObject({ status: "missing-evidence", command: null });
    expect(decision?.evidence.find((row) => row.id === "test")).toMatchObject({ status: "missing-evidence", command: null });
  });

  test("inferred-only evidence keeps its own dashboard label", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentops-ledger-render-")), "inferred.jsonl");
    writeFileSync(
      path,
      [
        { type: "session", id: "ledger-inferred", agent: "synthetic-agent" },
        { type: "tool_call", toolName: "Bash", input: { cmd: "bun test" }, status: "inferred" },
        { type: "final_response", role: "assistant", content: "Tests passed." }
      ]
        .map((record) => JSON.stringify({ schemaVersion: "agentops.event.v1", ...record }))
        .join("\n")
    );
    const decision = withSession(path, (store, sid) => getDashboardSession(store, sid, defaultConfig)?.decision);
    expect(decision?.mergeReadiness.reasons).toContain("1 claimed check has inferred command evidence.");
    expect(decision?.evidence.find((row) => row.id === "test")).toMatchObject({
      status: "inferred-evidence",
      command: "bun test"
    });
  });

  test("sessions without new claim kinds keep the same rows", () => {
    expect(evidence("fixtures/sample-session.jsonl")?.evidence.map((row) => row.id)).toEqual(["test", "lint", "typecheck", "build", "final-success"]);
  });
});

describe("freshness of a claimed verification run", () => {
  const pass = { type: "command", command: "bun test", status: "completed", exitCode: 0 };
  const edit = { type: "file_edit", path: "src/math.ts", operation: "edit" };
  const final = { type: "final_response", content: "All tests pass." };

  function check(events: object[]) {
    const path = join(mkdtempSync(join(tmpdir(), "agentops-freshness-")), "capture.jsonl");
    writeFileSync(path, [{ type: "session", id: "freshness" }, ...events].map(event => JSON.stringify(event)).join("\n"));
    return withSession(path, (store, id) => ({
      gate: evaluateQualityGate(store, id),
      decision: getDashboardSession(store, id, defaultConfig)!.decision,
      markdown: generateGithubRepoComment(store, id, [])
    }));
  }

  test("a pass followed by an edit cites the historical run and requests a rerun on every surface", () => {
    const { gate, decision, markdown } = check([pass, edit, final]);
    expect(gate.status).toBe("failed");
    expect(formatGateGithub(gate)).toContain("Rerun bun test: src/math.ts changed at step 2");
    expect(markdown).toContain("| test | Rerun needed | `bun test` (exit 0), step 1.");
    expect(decision.mergeReadiness.status).toBe("needs-review");
    for (const id of ["test", "final-success"]) {
      expect(decision.evidence.find(row => row.id === id)).toMatchObject({ status: "stale", eventStep: 1, commandExitCode: 0 });
    }
  });

  test("only a rerun before the claim resolves stale evidence, using its actual outcome", () => {
    expect(check([pass, edit, pass, final]).markdown).toContain("| test | Supported | `bun test` (exit 0), step 3");
    expect(check([pass, edit, { ...pass, exitCode: 1 }, final]).markdown).toContain("| test | Contradicted | `bun test` (exit 1), step 3");
    expect(check([pass, edit, final, pass]).gate.status).toBe("failed");
    expect(check([pass, final, edit]).gate.status).toBe("passed");
  });

  test("reads and changes without an applied outcome do not invalidate the run", () => {
    const attempts = ["denied", "failed", "no_result", "inferred", "killed"].map(status => ({ ...edit, status }));
    expect(check([pass, ...attempts, { ...edit, type: "file_read" }, final]).gate.status).toBe("passed");
  });
});

test("a native Codex test that overlaps an edit requires a rerun started after the edit", () => {
  const command = { type: "command_execution", id: "check", command: "bun test" };
  const start = { type: "item.started", item: { ...command, status: "in_progress" } };
  const end = { type: "item.completed", item: { ...command, status: "completed", exit_code: 0 } };
  const change = { type: "item.completed", item: { id: "edit", type: "file_change", status: "completed", changes: [{ kind: "update", path: "src/math.ts" }] } };
  for (const [events, expected] of [[[start, change, end], "failed"], [[change, start, end], "passed"]] as const) {
    const records = [{ type: "thread.started", thread_id: "overlap" }, ...events,
      { type: "item.completed", item: { id: "answer", type: "agent_message", text: "All tests pass." } }, { type: "turn.completed", usage: {} }];
    const input = { sourcePath: "overlap.jsonl", content: records.map(record => JSON.stringify(record)).join("\n") };
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-overlap-")), "session.db"));
    try {
      const { sessionId } = ingestTranscript(store, resolveAdapter(input).parse(input, defaultConfig), defaultConfig);
      expect(evaluateQualityGate(store, sessionId).status).toBe(expected);
    } finally {
      store.db.close();
    }
  }
});
