import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as storeApi from "../src/store";
import { defaultConfig } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
import { runCli } from "../src/cli";
import { startDashboardServer } from "../src/dashboard";

const originalDb = process.env.AGENTOPS_DB;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-dashboard-test-"));
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
});

afterEach(() => {
  if (originalDb === undefined) {
    delete process.env.AGENTOPS_DB;
  } else {
    process.env.AGENTOPS_DB = originalDb;
  }
});

test("dashboard API reads sessions from SQLite", async () => {
  const ingest = await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const sessionsResponse = await fetch(`${server.url}/api/sessions`);
    expect(sessionsResponse.status).toBe(200);
    const sessionsPayload = (await sessionsResponse.json()) as { sessions: Array<{ id: string; totalTokens: number | null }> };
    expect(sessionsPayload.sessions).toHaveLength(1);
    expect(sessionsPayload.sessions[0].id).toBe("sample-session");

    const detailResponse = await fetch(`${server.url}/api/sessions/sample-session`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      session: { id: string };
      evidenceQuality: {
        level: string;
        label: string;
        observedCommandCount: number;
        inferredCommandCount: number;
        inferredFileCount: number;
      };
      usage: { totalTokens: number | null };
      events: unknown[];
      commands: unknown[];
      files: unknown[];
      risks: unknown[];
      verification: unknown[];
      decision: {
        mergeReadiness: { status: string; missingEvidenceCount: number; verificationCount: number };
        evidence: Array<{ id: string; status: string; command: string | null }>;
      };
    };
    expect(detailPayload.session.id).toBe("sample-session");
    expect(detailPayload.evidenceQuality).toEqual(
      expect.objectContaining({
        level: "structured",
        label: "Structured JSONL",
        observedCommandCount: 2,
        inferredCommandCount: 0,
        inferredFileCount: 0
      })
    );
    expect(detailPayload.events.length).toBeGreaterThan(0);
    expect(detailPayload.commands.length).toBeGreaterThan(0);
    expect(detailPayload.files.length).toBeGreaterThan(0);
    expect(detailPayload.risks).toEqual([]);
    expect(detailPayload.verification.length).toBeGreaterThan(0);
    expect(detailPayload.decision.mergeReadiness.status).toBe("ready");
    expect(detailPayload.decision.mergeReadiness.missingEvidenceCount).toBe(0);
    expect(detailPayload.decision.mergeReadiness.verificationCount).toBeGreaterThan(0);
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({ id: "test", status: "verified", command: "bun test" })
    );
  } finally {
    server.stop();
  }
});

test("dashboard decision payload surfaces missing evidence and blocked readiness", async () => {
  const ingest = await runCli(["audit", "fixtures/risky-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/risky-session`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      decision: {
        mergeReadiness: { status: string; highRiskCount: number; missingEvidenceCount: number };
        evidence: Array<{ id: string; claimed: boolean; status: string; riskCategory: string | null }>;
      };
      riskDrilldown: {
        totals: { high: number; medium: number; low: number; total: number };
        groups: Array<{
          severity: string;
          category: string;
          count: number;
          risks: Array<{
            command: { command: string } | null;
            file: { path: string; linesAdded: number | null; linesRemoved: number | null } | null;
            evidence: { id: string; status: string } | null;
          }>;
        }>;
      };
    };

    expect(detailPayload.decision.mergeReadiness.status).toBe("blocked");
    expect(detailPayload.decision.mergeReadiness.highRiskCount).toBeGreaterThan(0);
    expect(detailPayload.decision.mergeReadiness.missingEvidenceCount).toBe(1);
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({
        id: "final-success",
        claimed: true,
        status: "missing-evidence",
        riskCategory: "unsupported-success-claim"
      })
    );
    expect(detailPayload.riskDrilldown.totals).toEqual({ high: 2, medium: 3, low: 0, total: 5 });
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "high",
        category: "destructive-command",
        count: 1,
        risks: [expect.objectContaining({ command: expect.objectContaining({ command: "rm -rf ./dist" }) })]
      })
    );
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "high",
        category: "sensitive-file",
        risks: [expect.objectContaining({ file: expect.objectContaining({ path: ".env" }) })]
      })
    );
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        category: "large-churn",
        risks: [
          expect.objectContaining({
            file: expect.objectContaining({ path: "deploy/production.yaml", linesAdded: 600, linesRemoved: 25 })
          })
        ]
      })
    );
    expect(detailPayload.riskDrilldown.groups).toContainEqual(
      expect.objectContaining({
        severity: "medium",
        category: "unsupported-success-claim",
        risks: [expect.objectContaining({ evidence: expect.objectContaining({ id: "final-success", status: "missing-evidence" }) })]
      })
    );
  } finally {
    server.stop();
  }
});

test("dashboard demo fixtures cover ready, needs-review, and blocked states", async () => {
  for (const fixture of ["fixtures/sample-session.jsonl", "fixtures/needs-review-session.jsonl", "fixtures/risky-session.jsonl"]) {
    const ingest = await runCli(["audit", fixture, "--quiet"]);
    expect(ingest.exitCode).toBe(0);
  }

  const server = startDashboardServer({ port: 0 });
  try {
    const ready = (await fetch(`${server.url}/api/sessions/sample-session`).then((response) => response.json())) as {
      decision: { mergeReadiness: { status: string } };
    };
    const needsReview = (await fetch(`${server.url}/api/sessions/needs-review-session`).then((response) => response.json())) as {
      decision: { mergeReadiness: { status: string; missingEvidenceCount: number }; evidence: Array<{ id: string; status: string }> };
    };
    const blocked = (await fetch(`${server.url}/api/sessions/risky-session`).then((response) => response.json())) as {
      decision: { mergeReadiness: { status: string } };
    };

    expect(ready.decision.mergeReadiness.status).toBe("ready");
    expect(needsReview.decision.mergeReadiness.status).toBe("needs-review");
    expect(needsReview.decision.mergeReadiness.missingEvidenceCount).toBe(1);
    expect(needsReview.decision.evidence).toContainEqual(expect.objectContaining({ id: "final-success", status: "missing-evidence" }));
    expect(blocked.decision.mergeReadiness.status).toBe("blocked");
  } finally {
    server.stop();
  }
});

test("dashboard API includes tool usage summary", async () => {
  const ingest = await runCli(["audit", "fixtures/codex-exec-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/codex-exec-sample`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      tools: Array<{ toolName: string; category: string; count: number }>;
    };

    expect(hasTool(detailPayload.tools, "shell", "shell", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "mcp__repo__read_file", "mcp", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "web_search", "web", 1)).toBe(true);
  } finally {
    server.stop();
  }
});

test("dashboard API includes Claude stream tool usage summary", async () => {
  const ingest = await runCli(["audit", "fixtures/claude-code-stream-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/claude-stream-sample`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      tools: Array<{ toolName: string; category: string; count: number }>;
    };

    expect(hasTool(detailPayload.tools, "Bash", "shell", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "Edit", "file", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "mcp__repo__read_file", "mcp", 1)).toBe(true);
    expect(hasTool(detailPayload.tools, "WebSearch", "web", 1)).toBe(true);
  } finally {
    server.stop();
  }
});

function hasTool(tools: Array<{ toolName: string; category: string; count: number }>, toolName: string, category: string, count: number): boolean {
  return tools.some((tool) => tool.toolName === toolName && tool.category === category && tool.count === count);
}

test("dashboard serves local HTML shell and 404s missing sessions", async () => {
  const server = startDashboardServer({ port: 0 });
  try {
    const htmlResponse = await fetch(server.url);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    const html = await htmlResponse.text();
    expect(html).toContain("AgentOps Workbench");
    expect(html).toContain("session-filter");
    expect(html).toContain("adapter-filter");
    expect(html).toContain("report-link");
    expect(html).toContain("Markdown report");
    expect(html).toContain("evidence-link");
    expect(html).toContain("JSON evidence");
    expect(html).toContain("compare-select");
    expect(html).toContain("Compare with");
    expect(html).toContain("Run Comparison");
    expect(html).toContain("Merge Readiness");
    expect(html).toContain("Evidence Quality");
    expect(html).toContain("Claim vs Evidence");
    expect(html).toContain("Risk Drilldown");

    const missingResponse = await fetch(`${server.url}/api/sessions/missing-session`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "Session not found" });
  } finally {
    server.stop();
  }
});

test("dashboard serves sanitized JSON evidence bundles for sessions", async () => {
  const ingest = await runCli(["audit", "fixtures/risky-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const evidenceResponse = await fetch(`${server.url}/api/sessions/risky-session/evidence`);
    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.headers.get("content-type")).toContain("application/json");
    expect(evidenceResponse.headers.get("content-disposition")).toContain('filename="risky-session-evidence.json"');
    const payload = (await evidenceResponse.json()) as {
      schemaVersion: string;
      kind: string;
      session: { id: string; source_path?: string; sourcePath?: string };
      evidenceQuality: { level: string; label: string };
      decision: { mergeReadiness: { status: string }; evidence: unknown[] };
      riskDrilldown: { totals: { total: number } };
      verification: Array<{ command: string; output?: string }>;
      commands: Array<{ command: string; output?: string }>;
      events: Array<{ summary: string; rawJson?: string; rawPayloadHash?: string }>;
    };

    expect(payload.schemaVersion).toBe("agentops.evidence.v1");
    expect(payload.kind).toBe("session-evidence");
    expect(payload.session.id).toBe("risky-session");
    expect(payload.session.source_path).toBeUndefined();
    expect(payload.session.sourcePath).toBeUndefined();
    expect(payload.evidenceQuality).toEqual(expect.objectContaining({ level: "structured", label: "Structured JSONL" }));
    expect(payload.decision.mergeReadiness.status).toBe("blocked");
    expect(payload.decision.evidence.length).toBeGreaterThan(0);
    expect(payload.riskDrilldown.totals.total).toBe(5);
    expect(payload.commands).toContainEqual(expect.objectContaining({ command: "rm -rf ./dist" }));
    expect(payload.commands.every((command) => command.output === undefined)).toBe(true);
    expect(payload.events.every((event) => event.rawJson === undefined && event.rawPayloadHash === undefined)).toBe(true);
    expect(payload.events.map((event) => event.summary)).toContain("Completed successfully.");

    const missingEvidence = await fetch(`${server.url}/api/sessions/missing-session/evidence`);
    expect(missingEvidence.status).toBe(404);
    expect(await missingEvidence.json()).toEqual({ error: "Session not found" });
  } finally {
    server.stop();
  }
});

test("dashboard labels forensic text evidence quality", async () => {
  const ingest = await runCli(["audit", "fixtures/forensic-terminal-transcript.txt", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/forensic-terminal-transcript-7c188a0d6c8148db717ea6ad15182164`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      evidenceQuality: {
        level: string;
        label: string;
        sourceAdapter: string | null;
        observedCommandCount: number;
        inferredCommandCount: number;
        inferredFileCount: number;
        notes: string[];
      };
      commands: Array<{ command: string; status: string | null }>;
      files: Array<{ path: string; operation: string }>;
      risks: Array<{ category: string }>;
    };

    expect(detailPayload.evidenceQuality).toEqual(
      expect.objectContaining({
        level: "forensic",
        label: "Forensic text",
        sourceAdapter: "forensic-text",
        observedCommandCount: 2,
        inferredCommandCount: 0,
        inferredFileCount: 2
      })
    );
    expect(detailPayload.evidenceQuality.notes.join(" ")).toContain("inferred");
    expect(detailPayload.commands).toContainEqual(expect.objectContaining({ command: "bun test", status: "observed" }));
    expect(detailPayload.files).toContainEqual(expect.objectContaining({ path: "src/server.ts", operation: "inferred edit" }));
    expect(detailPayload.risks).toContainEqual(expect.objectContaining({ category: "forensic-import" }));

    const evidenceResponse = await fetch(`${server.url}/api/sessions/forensic-terminal-transcript-7c188a0d6c8148db717ea6ad15182164/evidence`);
    expect(evidenceResponse.status).toBe(200);
    const evidencePayload = (await evidenceResponse.json()) as { evidenceQuality: { level: string; label: string } };
    expect(evidencePayload.evidenceQuality).toEqual(expect.objectContaining({ level: "forensic", label: "Forensic text" }));
  } finally {
    server.stop();
  }
});

test("dashboard distinguishes inferred forensic evidence from verified evidence", async () => {
  const ingest = await runCli(["audit", "fixtures/forensic-copied-chat.txt", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const detailResponse = await fetch(`${server.url}/api/sessions/forensic-copied-chat-031eb0e65c6914af5535e4a15e2fd566`);
    expect(detailResponse.status).toBe(200);
    const detailPayload = (await detailResponse.json()) as {
      evidenceQuality: {
        level: string;
        inferredCommandCount: number;
        inferredFileCount: number;
      };
      decision: {
        mergeReadiness: { status: string; reasons: string[]; missingEvidenceCount: number; verificationCount: number };
        evidence: Array<{ id: string; status: string; command: string | null; commandStatus: string | null }>;
      };
      commands: Array<{ command: string; status: string | null }>;
    };

    expect(detailPayload.evidenceQuality).toEqual(
      expect.objectContaining({
        level: "forensic",
        inferredCommandCount: 2,
        inferredFileCount: 1
      })
    );
    expect(detailPayload.commands).toContainEqual(expect.objectContaining({ command: "bun test", status: "inferred" }));
    expect(detailPayload.decision.mergeReadiness.status).toBe("needs-review");
    expect(detailPayload.decision.mergeReadiness.reasons.join(" ")).toContain("inferred command evidence");
    expect(detailPayload.decision.mergeReadiness.missingEvidenceCount).toBe(0);
    expect(detailPayload.decision.mergeReadiness.verificationCount).toBe(1);
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({ id: "test", status: "inferred-evidence", command: "bun test", commandStatus: "inferred" })
    );
    expect(detailPayload.decision.evidence).toContainEqual(
      expect.objectContaining({ id: "final-success", status: "inferred-evidence", command: "bun test", commandStatus: "inferred" })
    );
  } finally {
    server.stop();
  }
});

test("dashboard compares two sessions with decision and evidence deltas", async () => {
  const riskyIngest = await runCli(["audit", "fixtures/risky-session.jsonl", "--quiet"]);
  expect(riskyIngest.exitCode).toBe(0);
  const sampleIngest = await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"]);
  expect(sampleIngest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const compareResponse = await fetch(`${server.url}/api/compare?base=risky-session&target=sample-session`);
    expect(compareResponse.status).toBe(200);
    const comparison = (await compareResponse.json()) as {
      schemaVersion: string;
      kind: string;
      compatible: { sameRepo: boolean; message: string | null };
      base: { id: string; readiness: string; riskCount: number; verificationCount: number };
      target: { id: string; readiness: string; riskCount: number; verificationCount: number };
      deltas: { riskCount: number; highRiskCount: number; verificationCount: number; fileCount: number };
      risks: Array<{ severity: string; category: string; baseCount: number; targetCount: number; delta: number }>;
      files: { baseOnly: string[]; targetOnly: string[]; common: string[] };
      verification: { baseOnly: string[]; targetOnly: string[]; common: string[] };
    };

    expect(comparison.schemaVersion).toBe("agentops.comparison.v1");
    expect(comparison.kind).toBe("session-comparison");
    expect(comparison.compatible).toEqual({ sameRepo: true, message: null });
    expect(comparison.base).toEqual(expect.objectContaining({ id: "risky-session", readiness: "blocked", riskCount: 5, verificationCount: 0 }));
    expect(comparison.target).toEqual(expect.objectContaining({ id: "sample-session", readiness: "ready", riskCount: 0, verificationCount: 1 }));
    expect(comparison.deltas).toEqual(expect.objectContaining({ riskCount: -5, highRiskCount: -2, verificationCount: 1, fileCount: 0 }));
    expect(comparison.risks).toContainEqual(
      expect.objectContaining({ severity: "high", category: "destructive-command", baseCount: 1, targetCount: 0, delta: -1 })
    );
    expect(comparison.files.baseOnly).toContain(".env");
    expect(comparison.files.targetOnly).toContain("src/server.ts");
    expect(comparison.verification.targetOnly).toContain("bun test");

    const missingCompare = await fetch(`${server.url}/api/compare?base=risky-session&target=missing-session`);
    expect(missingCompare.status).toBe(404);
    expect(await missingCompare.json()).toEqual({ error: "Session not found" });

    const sameCompare = await fetch(`${server.url}/api/compare?base=risky-session&target=risky-session`);
    expect(sameCompare.status).toBe(400);
    expect(await sameCompare.json()).toEqual({ error: "Choose two different sessions" });

    const incompleteCompare = await fetch(`${server.url}/api/compare?base=risky-session`);
    expect(incompleteCompare.status).toBe(400);
    expect(await incompleteCompare.json()).toEqual({ error: "Missing base or target session" });
  } finally {
    server.stop();
  }
});

test("dashboard serves markdown reports for sessions", async () => {
  const ingest = await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"]);
  expect(ingest.exitCode).toBe(0);

  const server = startDashboardServer({ port: 0 });
  try {
    const reportResponse = await fetch(`${server.url}/api/sessions/sample-session/report`);
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.headers.get("content-type")).toContain("text/markdown");
    const report = await reportResponse.text();
    expect(report).toContain("# AgentOps Session Report");
    expect(report).toContain("sample-session");
    expect(report).toContain("`bun test`");

    const missingReport = await fetch(`${server.url}/api/sessions/missing-session/report`);
    expect(missingReport.status).toBe(404);
    expect(await missingReport.json()).toEqual({ error: "Session not found" });
  } finally {
    server.stop();
  }
});

test("agentops open reads the project config like check does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-open-config-test-"));
  const originalCwd = process.cwd();
  const sessionPath = join(dir, "ci-session.jsonl");
  writeFileSync(
    join(dir, "agentops.config.json"),
    JSON.stringify({ schemaVersion: "agentops.config.v1", evidence: { verificationCommands: ["ci"], supportCommands: { test: ["bun run ci"] } } })
  );
  writeFileSync(
    sessionPath,
    [
      { schemaVersion: "agentops.event.v1", type: "session", id: "configured-ci" },
      { schemaVersion: "agentops.event.v1", type: "command", command: "bun run ci", status: "completed", exitCode: 0 },
      { schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", summary: "Tests passed." }
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")
  );
  process.chdir(dir);
  try {
    const audit = await runCli(["audit", sessionPath]);
    expect(audit.exitCode).toBe(0);
    const check = await runCli(["check", "configured-ci"]);
    expect(check.exitCode).toBe(0);

    // `open` refuses port 0, so borrow a free port from the OS first.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = String(probe.port);
    probe.stop(true);
    const open = await runCli(["open", "--port", port]);
    const url = /listening at (\S+)/.exec(open.stdout ?? "")?.[1];
    expect(url).toBeDefined();
    try {
      type Detail = { decision: { evidence: Array<{ id: string; status: string; command: string | null }> } };
      const detail = (await (await fetch(`${url}/api/sessions/configured-ci`)).json()) as Detail;
      expect(detail.decision.evidence.find((row) => row.id === "test")).toMatchObject({ status: "verified", command: "bun run ci", commandExitCode: 0 });
      expect(detail.decision.evidence.filter((row) => row.status === "missing-evidence")).toEqual([]);

      const bundle = (await (await fetch(`${url}/api/sessions/configured-ci/evidence`)).json()) as Record<string, unknown>;
      expect(JSON.stringify(bundle)).not.toContain("missing-evidence");
    } finally {
      process.emit("SIGTERM");
      await open.keepAlive;
    }
  } finally {
    process.chdir(originalCwd);
  }
});

test("dashboard CLI check validates local configuration without starting a server", async () => {
  const result = await runCli(["open", "--check", "--port", "4930"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Dashboard configuration OK");
  expect(result.stdout).toContain("Host: 127.0.0.1");
  expect(result.stdout).toContain("Port: 4930");
  expect(result.stdout).toContain("Database:");
});

test("an evidence download stays consistent while SessionEnd imports another session", async () => {
  const repo = mkdtempSync(join(tmpdir(), "agentops-overlap-"));
  const state = join(repo, "state");
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const env = { ...process.env, AGENTOPS_STATE_DIR: state };
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  expect(Bun.spawnSync([process.execPath, main, "recorder", "enable"], { cwd: repo, env }).exitCode).toBe(0);
  expect((await runCli(["audit", "fixtures/sample-session.jsonl", "--quiet"])).exitCode).toBe(0);
  const db = new Database(process.env.AGENTOPS_DB!, { readonly: true });
  const server = startDashboardServer({ port: 0 });
  const evidence = async () => {
    const response = await fetch(`${server.url}/api/sessions/sample-session/evidence`);
    expect(response.status).toBe(200);
    return response.json();
  };
  const input = join(repo, "session-end.json");
  writeFileSync(input, JSON.stringify({ session_id: "session-b", cwd: repo, hook_event_name: "SessionEnd" }));
  const endSession = () => Bun.spawn([process.execPath, main, "hook", "SessionEnd"], {
    cwd: repo, env, stdout: "ignore", stderr: "ignore",
    stdin: Bun.file(input)
  });
  let writer: ReturnType<typeof endSession> | undefined;
  const getFiles = storeApi.getFileChanges;
  const readFiles = spyOn(storeApi, "getFileChanges");
  try {
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    const original = await evidence();
    readFiles.mockImplementationOnce((store, id) => {
      const rows = getFiles(store, id);
      writer = endSession();
      // The hook appends SessionEnd before importing. Give the writer a short
      // overlap, then finish this download independently of the import outcome.
      const spool = join(state, "spool", "session-b.jsonl");
      const until = performance.now() + 2000;
      while (!existsSync(spool) && performance.now() < until) Bun.sleepSync(2);
      expect(existsSync(spool)).toBe(true);
      Bun.sleepSync(150);
      return rows;
    });
    expect(await evidence()).toEqual(original);
    expect(writer).toBeDefined();
    expect(await writer!.exited).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM sessions WHERE id = 'session-b'").get()).toEqual({ n: 1 });
    expect(existsSync(join(state, "spool", "session-b.errors.jsonl"))).toBe(false);
  } finally {
    readFiles.mockRestore();
    server.stop();
    if (writer) await writer.exited;
    db.close();
  }
});

/** WAL lets a replacement commit between two reads without stopping the reader. */
function snapshotReimport(command: string | null, final: string) {
  const path = process.env.AGENTOPS_DB!;
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
  const trace = path + ".jsonl";
  const rows = [
    { type: "session", id: "reimport" },
    ...(command ? [{ type: "command", command, status: "completed", exitCode: 0 }] : []),
    { type: "final_response", role: "assistant", summary: final }
  ];
  writeFileSync(trace, rows.map((row) => JSON.stringify({ ...row, schemaVersion: "agentops.event.v1" })).join("\n"));
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "audit", trace, "--quiet"], { env: { ...process.env } });
  expect(result.exitCode).toBe(0);
}

test("a check overlapping reimport cannot pass by mixing two failing session versions", async () => {
  snapshotReimport("bun run lint", "Tests passed.");
  const check = () => runCli(["check", "reimport", "--format", "json"]);
  expect((await check()).exitCode).toBe(1);
  const risks = storeApi.getRiskFlags;
  const read = spyOn(storeApi, "getRiskFlags").mockImplementationOnce((store, id) => {
    const original = risks(store, id);
    snapshotReimport(null, "Work recorded.");
    return original;
  });
  try {
    const result = await check();
    expect(read).toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout!).status).toBe("failed");
  } finally {
    read.mockRestore();
  }
  expect((await check()).exitCode).toBe(1);
});

test("an evidence download overlapping reimport contains one whole session version", async () => {
  snapshotReimport("bun run lint", "Work recorded.");
  const server = startDashboardServer({ port: 0 });
  const bundle = async () => {
    const response = await fetch(`${server.url}/api/sessions/reimport/evidence`);
    expect(response.status).toBe(200);
    return response.json();
  };
  const files = storeApi.getFileChanges;
  const read = spyOn(storeApi, "getFileChanges");
  try {
    const original = await bundle();
    read.mockImplementationOnce((store, id) => {
      const rows = files(store, id);
      snapshotReimport("bun test", "Tests passed.");
      return rows;
    });
    expect(await bundle()).toEqual(original);
    const replacement = await bundle() as { decision: { evidence: unknown[] } };
    expect(replacement.decision.evidence).toContainEqual(expect.objectContaining({ id: "test", status: "verified", command: "bun test" }));
  } finally {
    read.mockRestore();
    server.stop();
  }
});

test("dashboard enforces the same named verification requirements as the gate", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "agentops-required-command-")), "capture.jsonl");
  const testRun = { type: "command", command: "bun test", status: "completed", exitCode: 0 };
  const lint = { type: "command", command: "bun run lint" };
  const cases = [
    { required: [], runs: [], missing: [] },
    { required: ["lint"], runs: [], missing: ["lint"] },
    { required: ["LINT"], runs: [{ ...lint, status: "completed", exitCode: 0 }], missing: [] },
    { required: ["lint", "typecheck"], runs: [{ ...lint, status: "completed", exitCode: 0 }], missing: ["typecheck"] },
    { required: ["lint"], runs: [{ ...lint, status: "inferred" }], missing: ["lint"] },
    { required: ["lint"], runs: [{ ...lint, status: "no_result" }], missing: ["lint"] }
  ];
  for (const { required, runs, missing } of cases) {
    const config = { ...defaultConfig, gates: { ...defaultConfig.gates, requireVerification: false, requiredVerificationCommands: required } };
    writeFileSync(path, [{ type: "session", id: "command-policy" }, testRun, ...runs].map(event => JSON.stringify(event)).join("\n"));
    expect((await runCli(["audit", path, "--quiet"])).exitCode).toBe(0);
    const store = storeApi.openStore();
    const server = startDashboardServer({ port: 0, config });
    try {
      const gate = evaluateQualityGate(store, "command-policy", config);
      expect(gate.status).toBe(missing.length ? "failed" : "passed");
      const failures = gate.checks.filter(check => check.id.startsWith("required-command:") && check.status === "failed");
      expect(failures.map(check => check.id)).toEqual(missing.map(name => `required-command:${name}`));
      for (const suffix of ["", "/evidence"]) {
        const result = await fetch(`${server.url}/api/sessions/command-policy${suffix}`);
        expect(result.status).toBe(200);
        const { decision } = await result.json() as { decision: { mergeReadiness: { status: string; reasons: string[] } } };
        expect(decision.mergeReadiness.status).toBe(missing.length ? "blocked" : "ready");
        for (const check of failures) expect(decision.mergeReadiness.reasons).toContain(check.message);
      }
    } finally {
      server.stop();
      store.db.close();
    }
  }
});
