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
        "| test success | Supported | `bun test` (exit 0), step 4 (evt-0002-test-pass) |",
        "| a fix | Supported | `bun test` (exit 0), step 4 (evt-0002-test-pass) |"
      ].join("\n")
    );
    expect(report).toContain("- 4. **tool_call**");
  });

  test("contradicted and unsupported claims say so", () => {
    const contradicted = withSession("fixtures/ledger/fail-then-claim.jsonl", (store, sid) => generateMarkdownReport(store, sid));
    expect(contradicted).toContain("| test success | Contradicted | `bun test` (exit 1), step 3 |");
    const unsupported = withSession("fixtures/ledger/callers-unsearched.jsonl", (store, sid) => generateMarkdownReport(store, sid));
    expect(unsupported).toContain("| there are no other callers or usages | Unsupported | No observed search run before the final response. |");
  });

  test("a final response without claims gets no ledger section", () => {
    const report = withSession("fixtures/sample-session.jsonl", (store, sid) => generateMarkdownReport(store, sid));
    expect(report).not.toContain("## Claims Ledger");
  });
});

describe("PR comment", () => {
  test("includes the claims table", () => {
    const comment = withSession("fixtures/ledger/fail-then-claim.jsonl", (store, sid) => generateGithubRepoComment(store, sid, []));
    expect(section(comment, "### Claims", "### Risk Flags")).toContain("| test success | Contradicted | `bun test` (exit 1), step 3 |");
  });
});

describe("dashboard evidence rows", () => {
  const evidence = (fixture: string) => withSession(fixture, (store, sid) => getDashboardSession(store, sid, defaultConfig)?.decision);

  test("a contradicted claim shows as contradicted and needs review", () => {
    const decision = evidence("fixtures/ledger/fail-then-claim.jsonl");
    expect(decision?.evidence.find((row) => row.id === "test")).toMatchObject({ status: "contradicted", command: "bun test", commandExitCode: 1, riskCategory: "contradicted-claim" });
    expect(decision?.evidence.find((row) => row.id === "fix")).toMatchObject({ label: "Fix verified", status: "contradicted" });
    expect(decision?.mergeReadiness.status).toBe("needs-review");
    expect(decision?.mergeReadiness.reasons).toContain("2 claimed checks are contradicted by a failing run.");
  });

  test("a supported claim cites the passing run, not the earlier failure", () => {
    const decision = evidence("fixtures/ledger/fail-then-pass-then-claim.jsonl");
    expect(decision?.evidence.find((row) => row.id === "test")).toMatchObject({ status: "verified", command: "bun test", commandExitCode: 0 });
  });

  test("new claim kinds get their own rows, including tool-call evidence", () => {
    expect(evidence("fixtures/ledger/browser-checked.jsonl")?.evidence.find((row) => row.id === "browser")).toMatchObject({
      label: "In-browser check",
      status: "verified",
      command: "mcp__playwright__browser_take_screenshot"
    });
    expect(evidence("fixtures/ledger/callers-unsearched.jsonl")?.evidence.find((row) => row.id === "callers")).toMatchObject({
      label: "No other callers",
      status: "missing-evidence",
      riskCategory: "missing-callers-evidence"
    });
  });

  test("a test that ran only after the final claim is unsupported on both surfaces", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentops-ledger-render-")), "late-run.jsonl");
    writeFileSync(
      path,
      [
        { type: "session", id: "ledger-late-run", agent: "synthetic-agent" },
        { type: "final_response", role: "assistant", content: "All tests pass." },
        { type: "tool_call", toolName: "Bash", input: { cmd: "bun test" }, status: "completed", exitCode: 0 }
      ]
        .map((record) => JSON.stringify({ schemaVersion: "agentops.event.v1", ...record }))
        .join("\n")
    );
    const [report, decision] = withSession(path, (store, sid) => [generateMarkdownReport(store, sid), getDashboardSession(store, sid, defaultConfig)?.decision] as const);
    expect(report).toContain("| test success | Unsupported |");
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
