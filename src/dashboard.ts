import dashboardShell from "./dashboard.html" with { type: "text" };
import dashboardCss from "./dashboard.css" with { type: "text" };
import dashboardClientJs from "./dashboard.client.js" with { type: "text" };
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import {
  getDashboardComparison,
  getDashboardSession,
  toDashboardSessionSummary,
  toEvidenceBundle,
  type DashboardEvidenceBundle
} from "./dashboardData";
import { generateMarkdownReport } from "./report";
import { getSession, listSessions, openStore, type Store } from "./store";

export type DashboardOptions = {
  host?: string;
  port?: number;
  storePath?: string;
  config?: AgentOpsConfig;
};

export type DashboardServer = {
  url: string;
  stop: () => void;
};


export function startDashboardServer(options: DashboardOptions = {}): DashboardServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4927;
  const config = options.config ?? defaultConfig;
  const store = openStore(options.storePath);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(request) {
      return handleDashboardRequest(request, store, config);
    }
  });

  return {
    url: server.url.toString().replace(/\/$/, ""),
    stop: () => {
      server.stop(true);
      store.db.close();
    }
  };
}

function handleDashboardRequest(request: Request, store: Store, config: AgentOpsConfig): Response {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return htmlResponse(dashboardHtml());
  }
  if (url.pathname === "/api/health") {
    return jsonResponse({ ok: true, localOnly: true, database: store.path });
  }
  if (url.pathname === "/api/sessions") {
    const limit = positiveLimit(url.searchParams.get("limit"));
    return jsonResponse({ sessions: listSessions(store, limit).map(toDashboardSessionSummary) });
  }
  if (url.pathname === "/api/compare") {
    const baseId = url.searchParams.get("base");
    const targetId = url.searchParams.get("target");
    if (!baseId || !targetId) return jsonResponse({ error: "Missing base or target session" }, 400);
    if (baseId === targetId) return jsonResponse({ error: "Choose two different sessions" }, 400);
    const comparison = getDashboardComparison(store, baseId, targetId, config);
    if (!comparison) return jsonResponse({ error: "Session not found" }, 404);
    return jsonResponse(comparison);
  }
  if (url.pathname.startsWith("/api/sessions/")) {
    const sessionPath = url.pathname.replace("/api/sessions/", "");
    const isReport = sessionPath.endsWith("/report");
    const isEvidence = sessionPath.endsWith("/evidence");
    const sessionId = decodeURIComponent(isReport ? sessionPath.slice(0, -"/report".length) : isEvidence ? sessionPath.slice(0, -"/evidence".length) : sessionPath);
    if (isReport) {
      const session = getSession(store, sessionId);
      if (!session) return jsonResponse({ error: "Session not found" }, 404);
      return markdownResponse(generateMarkdownReport(store, sessionId, config));
    }
    if (isEvidence) {
      const detail = getDashboardSession(store, sessionId, config);
      if (!detail) return jsonResponse({ error: "Session not found" }, 404);
      return evidenceResponse(toEvidenceBundle(detail));
    }
    const detail = getDashboardSession(store, sessionId, config);
    if (!detail) return jsonResponse({ error: "Session not found" }, 404);
    return jsonResponse(detail);
  }
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function positiveLimit(value: string | null): number {
  const parsed = Number(value ?? "50");
  if (!Number.isInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 200);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function htmlResponse(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function markdownResponse(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function evidenceResponse(value: DashboardEvidenceBundle): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${safeFilename(value.session.id)}-evidence.json"`
    }
  });
}

function safeFilename(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "session";
}

let cachedDashboardHtml: string | null = null;

function dashboardHtml(): string {
  if (cachedDashboardHtml === null) {
    // Assets are imported as text so Bun embeds them at build time — this works
    // both when run from source and inside a `bun build --compile` binary.
    // bun-types types text imports as bundle objects; at runtime with
    // `type: "text"` they are strings, so cast. Function replacers avoid
    // `$`-pattern interpretation in CSS/JS content.
    const shell = dashboardShell as unknown as string;
    const css = dashboardCss as unknown as string;
    const js = dashboardClientJs as unknown as string;
    cachedDashboardHtml = shell.replace("/*__DASHBOARD_CSS__*/", () => css).replace("//__DASHBOARD_JS__", () => js);
  }
  return cachedDashboardHtml;
}
