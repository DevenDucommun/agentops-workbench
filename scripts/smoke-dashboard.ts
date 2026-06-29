import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { startDashboardServer } from "../src/dashboard";

const originalDb = process.env.AGENTOPS_DB;
process.env.AGENTOPS_DB = join(mkdtempSync(join(tmpdir(), "agentops-dashboard-smoke-")), "agentops.db");

try {
  const ingest = await runCli(["ingest", "fixtures/usage-session.jsonl"]);
  if (ingest.exitCode !== 0) fail(ingest.stderr ?? "Dashboard smoke ingest failed.");

  const server = startDashboardServer({ port: 0 });
  try {
    const html = await fetch(server.url).then((response) => response.text());
    if (!html.includes("AgentOps Workbench")) fail("Dashboard HTML shell did not render title.");
    if (!html.includes("report-link")) fail("Dashboard HTML shell did not include report link.");
    if (!html.includes("Merge Readiness")) fail("Dashboard HTML shell did not include merge-readiness panel.");
    if (!html.includes("Claim vs Evidence")) fail("Dashboard HTML shell did not include claim/evidence panel.");

    const detailResponse = await fetch(`${server.url}/api/sessions/usage-session`);
    if (!detailResponse.ok) fail(`Dashboard session API failed: ${detailResponse.status}`);
    const detail = (await detailResponse.json()) as {
      session?: { id?: string };
      usage?: { totalTokens?: number };
      decision?: {
        mergeReadiness?: { status?: string; missingEvidenceCount?: number };
        evidence?: Array<{ id?: string; status?: string }>;
      };
    };
    if (detail.session?.id !== "usage-session") fail("Dashboard session API returned wrong session.");
    if (detail.usage?.totalTokens !== 1540) fail("Dashboard session API returned wrong token total.");
    if (detail.decision?.mergeReadiness?.status !== "ready") fail("Dashboard session API returned wrong readiness status.");
    if (detail.decision.mergeReadiness.missingEvidenceCount !== 0) fail("Dashboard session API returned wrong missing evidence count.");
    if (!detail.decision.evidence?.some((row) => row.id === "final-success" && row.status === "verified")) {
      fail("Dashboard session API did not include verified final-success evidence.");
    }

    const report = await fetch(`${server.url}/api/sessions/usage-session/report`).then((response) => response.text());
    if (!report.includes("# AgentOps Session Report")) fail("Dashboard report endpoint did not render Markdown report.");
  } finally {
    server.stop();
  }
} finally {
  if (originalDb === undefined) {
    delete process.env.AGENTOPS_DB;
  } else {
    process.env.AGENTOPS_DB = originalDb;
  }
}

console.log("Dashboard smoke passed.");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
