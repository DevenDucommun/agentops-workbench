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

    const detailResponse = await fetch(`${server.url}/api/sessions/usage-session`);
    if (!detailResponse.ok) fail(`Dashboard session API failed: ${detailResponse.status}`);
    const detail = (await detailResponse.json()) as { session?: { id?: string }; usage?: { totalTokens?: number } };
    if (detail.session?.id !== "usage-session") fail("Dashboard session API returned wrong session.");
    if (detail.usage?.totalTokens !== 1540) fail("Dashboard session API returned wrong token total.");

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
