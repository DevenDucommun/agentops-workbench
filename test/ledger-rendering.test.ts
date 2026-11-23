import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
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
        { type: "final_response", role: "assistant", content: "All tests pass." }
      ]
        .map((record) => JSON.stringify({ schemaVersion: "agentops.event.v1", ...record }))
        .join("\n")
    );
    expect(withSession(path, (store, sid) => getDashboardSession(store, sid, defaultConfig)?.decision)?.evidence.find((row) => row.id === "test")).toMatchObject({
      status: "inferred-evidence",
      command: "bun test"
    });
  });

  test("sessions without new claim kinds keep the same rows", () => {
    expect(evidence("fixtures/sample-session.jsonl")?.evidence.map((row) => row.id)).toEqual(["test", "lint", "typecheck", "build", "final-success"]);
  });
});
