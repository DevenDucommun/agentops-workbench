import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { startDashboardServer } from "../src/dashboard";

const originalDb = process.env.AGENTOPS_DB;
process.env.AGENTOPS_DB = join(mkdtempSync(join(tmpdir(), "agentops-dashboard-smoke-")), "agentops.db");

try {
  const emptyServer = startDashboardServer({ port: 0 });
  try {
    const emptySessions = (await fetch(`${emptyServer.url}/api/sessions`).then((response) => response.json())) as { sessions?: unknown[] };
    if (emptySessions.sessions?.length !== 0) fail("Dashboard empty state returned sessions.");
    const emptyHtml = await fetch(emptyServer.url).then((response) => response.text());
    if (!emptyHtml.includes("No session selected")) fail("Dashboard empty HTML shell did not include empty heading.");
  } finally {
    emptyServer.stop();
  }

  const ingest = await runCli(["ingest", "fixtures/usage-session.jsonl"]);
  if (ingest.exitCode !== 0) fail(ingest.stderr ?? "Dashboard smoke ingest failed.");
  const riskyIngest = await runCli(["ingest", "fixtures/risky-session.jsonl"]);
  if (riskyIngest.exitCode !== 0) fail(riskyIngest.stderr ?? "Dashboard risky fixture ingest failed.");
  const sampleIngest = await runCli(["ingest", "fixtures/sample-session.jsonl"]);
  if (sampleIngest.exitCode !== 0) fail(sampleIngest.stderr ?? "Dashboard sample fixture ingest failed.");
  const reviewIngest = await runCli(["ingest", "fixtures/needs-review-session.jsonl"]);
  if (reviewIngest.exitCode !== 0) fail(reviewIngest.stderr ?? "Dashboard needs-review fixture ingest failed.");

  const server = startDashboardServer({ port: 0 });
  try {
    const html = await fetch(server.url).then((response) => response.text());
    if (!html.includes("AgentOps Workbench")) fail("Dashboard HTML shell did not render title.");
    if (!html.includes("report-link")) fail("Dashboard HTML shell did not include report link.");
    if (!html.includes("evidence-link")) fail("Dashboard HTML shell did not include evidence link.");
    if (!html.includes("Merge Readiness")) fail("Dashboard HTML shell did not include merge-readiness panel.");
    if (!html.includes("Claim vs Evidence")) fail("Dashboard HTML shell did not include claim/evidence panel.");
    if (!html.includes("Risk Drilldown")) fail("Dashboard HTML shell did not include risk drilldown.");

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

    const sampleResponse = await fetch(`${server.url}/api/sessions/sample-session`);
    if (!sampleResponse.ok) fail(`Dashboard sample session API failed: ${sampleResponse.status}`);
    const sampleDetail = (await sampleResponse.json()) as {
      decision?: { mergeReadiness?: { status?: string } };
      riskDrilldown?: { totals?: { total?: number } };
    };
    if (sampleDetail.decision?.mergeReadiness?.status !== "ready") fail("Dashboard ready fixture returned wrong readiness.");
    if (sampleDetail.riskDrilldown?.totals?.total !== 0) fail("Dashboard ready fixture returned risks.");

    const reviewResponse = await fetch(`${server.url}/api/sessions/needs-review-session`);
    if (!reviewResponse.ok) fail(`Dashboard needs-review session API failed: ${reviewResponse.status}`);
    const reviewDetail = (await reviewResponse.json()) as {
      decision?: {
        mergeReadiness?: { status?: string; missingEvidenceCount?: number };
        evidence?: Array<{ id?: string; status?: string }>;
      };
    };
    if (reviewDetail.decision?.mergeReadiness?.status !== "needs-review") fail("Dashboard needs-review fixture returned wrong readiness.");
    if (reviewDetail.decision.mergeReadiness.missingEvidenceCount !== 1) fail("Dashboard needs-review fixture returned wrong missing evidence count.");
    if (!reviewDetail.decision.evidence?.some((row) => row.id === "final-success" && row.status === "missing-evidence")) {
      fail("Dashboard needs-review fixture did not include missing final-success evidence.");
    }

    const riskyResponse = await fetch(`${server.url}/api/sessions/risky-session`);
    if (!riskyResponse.ok) fail(`Dashboard risky session API failed: ${riskyResponse.status}`);
    const riskyDetail = (await riskyResponse.json()) as {
      riskDrilldown?: {
        totals?: { high?: number; medium?: number; total?: number };
        groups?: Array<{
          category?: string;
          risks?: Array<{ command?: { command?: string } | null; file?: { path?: string } | null; evidence?: { id?: string } | null }>;
        }>;
      };
    };
    if (riskyDetail.riskDrilldown?.totals?.total !== 5) fail("Dashboard risky session returned wrong risk total.");
    if (!riskyDetail.riskDrilldown.groups?.some((group) => group.category === "destructive-command" && group.risks?.some((risk) => risk.command?.command === "rm -rf ./dist"))) {
      fail("Dashboard risk drilldown did not link the destructive command.");
    }
    if (!riskyDetail.riskDrilldown.groups?.some((group) => group.category === "sensitive-file" && group.risks?.some((risk) => risk.file?.path === ".env"))) {
      fail("Dashboard risk drilldown did not link the sensitive file.");
    }
    if (!riskyDetail.riskDrilldown.groups?.some((group) => group.category === "unsupported-success-claim" && group.risks?.some((risk) => risk.evidence?.id === "final-success"))) {
      fail("Dashboard risk drilldown did not link missing final-success evidence.");
    }

    const evidenceResponse = await fetch(`${server.url}/api/sessions/risky-session/evidence`);
    if (!evidenceResponse.ok) fail(`Dashboard evidence endpoint failed: ${evidenceResponse.status}`);
    if (!evidenceResponse.headers.get("content-type")?.includes("application/json")) fail("Dashboard evidence endpoint returned wrong content type.");
    const evidence = (await evidenceResponse.json()) as {
      schemaVersion?: string;
      session?: { id?: string; sourcePath?: string; source_path?: string };
      commands?: Array<{ output?: string }>;
      events?: Array<{ rawJson?: string; rawPayloadHash?: string }>;
      riskDrilldown?: { totals?: { total?: number } };
    };
    if (evidence.schemaVersion !== "agentops.evidence.v1") fail("Dashboard evidence endpoint returned wrong schema.");
    if (evidence.session?.id !== "risky-session") fail("Dashboard evidence endpoint returned wrong session.");
    if (evidence.session.sourcePath !== undefined || evidence.session.source_path !== undefined) fail("Dashboard evidence endpoint leaked source path.");
    if (evidence.commands?.some((command) => command.output !== undefined)) fail("Dashboard evidence endpoint included command output.");
    if (evidence.events?.some((event) => event.rawJson !== undefined || event.rawPayloadHash !== undefined)) {
      fail("Dashboard evidence endpoint included raw event data.");
    }
    if (evidence.riskDrilldown?.totals?.total !== 5) fail("Dashboard evidence endpoint returned wrong risk drilldown.");

    const comparisonResponse = await fetch(`${server.url}/api/compare?base=risky-session&target=sample-session`);
    if (!comparisonResponse.ok) fail(`Dashboard comparison endpoint failed: ${comparisonResponse.status}`);
    const comparison = (await comparisonResponse.json()) as {
      schemaVersion?: string;
      compatible?: { sameRepo?: boolean };
      deltas?: { riskCount?: number; highRiskCount?: number; verificationCount?: number };
      verification?: { targetOnly?: string[] };
    };
    if (comparison.schemaVersion !== "agentops.comparison.v1") fail("Dashboard comparison endpoint returned wrong schema.");
    if (comparison.compatible?.sameRepo !== true) fail("Dashboard comparison endpoint returned incompatible synthetic sessions.");
    if (comparison.deltas?.riskCount !== -5) fail("Dashboard comparison endpoint returned wrong risk delta.");
    if (comparison.deltas.highRiskCount !== -2) fail("Dashboard comparison endpoint returned wrong high-risk delta.");
    if (comparison.deltas.verificationCount !== 1) fail("Dashboard comparison endpoint returned wrong verification delta.");
    if (!comparison.verification?.targetOnly?.includes("bun test")) fail("Dashboard comparison endpoint did not include target-only verification.");

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
