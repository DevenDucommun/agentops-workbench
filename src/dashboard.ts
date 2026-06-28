import { isVerificationCommand } from "./analyzer";
import type { AgentOpsConfig } from "./config";
import { defaultConfig } from "./config";
import {
  getCommands,
  getEvents,
  getFileChanges,
  getRiskFlags,
  getSession,
  getUsageSummary,
  listSessions,
  openStore,
  type Store
} from "./store";
import type { CommandRecord, FileChangeRecord, RiskFlagRecord, SessionSummary, StoredEvent, UsageSummary } from "./types";

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

type DashboardSessionDetail = {
  session: DashboardSessionRecord;
  usage: UsageSummary;
  events: StoredEvent[];
  commands: CommandRecord[];
  files: FileChangeRecord[];
  risks: RiskFlagRecord[];
  verification: CommandRecord[];
};

type DashboardSessionRecord = Omit<NonNullable<ReturnType<typeof getSession>>, "source_path">;

type DashboardSessionSummary = Omit<SessionSummary, "sourcePath">;

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
  if (url.pathname.startsWith("/api/sessions/")) {
    const sessionId = decodeURIComponent(url.pathname.replace("/api/sessions/", ""));
    const detail = getDashboardSession(store, sessionId, config);
    if (!detail) return jsonResponse({ error: "Session not found" }, 404);
    return jsonResponse(detail);
  }
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function getDashboardSession(store: Store, sessionId: string, config: AgentOpsConfig): DashboardSessionDetail | null {
  const session = getSession(store, sessionId);
  if (!session) return null;

  const commands = getCommands(store, sessionId);
  return {
    session: toDashboardSessionRecord(session),
    usage: getUsageSummary(store, sessionId),
    events: getEvents(store, sessionId),
    commands,
    files: getFileChanges(store, sessionId),
    risks: getRiskFlags(store, sessionId),
    verification: commands.filter((command) => isVerificationCommand(command.command, config))
  };
}

function toDashboardSessionSummary(session: SessionSummary): DashboardSessionSummary {
  const { sourcePath: _sourcePath, ...rest } = session;
  return rest;
}

function toDashboardSessionRecord(session: NonNullable<ReturnType<typeof getSession>>): DashboardSessionRecord {
  const { source_path: _sourcePath, ...rest } = session;
  return rest;
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

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentOps Workbench</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #18212f;
      --muted: #657386;
      --line: #d9e0e8;
      --accent: #246b55;
      --accent-soft: #e2f1ea;
      --risk: #b42318;
      --risk-soft: #fbe9e7;
      --warn: #9a5b12;
      --warn-soft: #fff2d8;
      --ok: #237044;
      --shadow: 0 1px 2px rgba(24, 33, 47, 0.06);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-size: 14px;
      line-height: 1.45;
    }
    button, input { font: inherit; }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(260px, 340px) 1fr;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: #fbfcfd;
      padding: 18px 14px;
      overflow: auto;
      max-height: 100vh;
      position: sticky;
      top: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 18px; font-weight: 700; letter-spacing: 0; }
    h2 { font-size: 16px; font-weight: 700; letter-spacing: 0; }
    h3 { font-size: 13px; font-weight: 700; letter-spacing: 0; color: var(--muted); text-transform: uppercase; }
    .subtle { color: var(--muted); }
    .refresh {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      width: 34px;
      height: 34px;
      cursor: pointer;
      box-shadow: var(--shadow);
    }
    .sessions {
      display: grid;
      gap: 8px;
    }
    .session-button {
      width: 100%;
      min-height: 86px;
      text-align: left;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      box-shadow: var(--shadow);
    }
    .session-button.active {
      border-color: var(--accent);
      outline: 2px solid rgba(36, 107, 85, 0.16);
    }
    .session-title {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 8px;
      margin-bottom: 6px;
      font-weight: 700;
    }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      background: #edf1f5;
      color: #344153;
      font-size: 12px;
      white-space: nowrap;
    }
    .pill.risk { color: var(--risk); background: var(--risk-soft); }
    .pill.ok { color: var(--ok); background: var(--accent-soft); }
    .main {
      padding: 22px;
      min-width: 0;
    }
    .header {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: start;
      gap: 16px;
      margin-bottom: 18px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(116px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .metric {
      min-height: 78px;
      padding: 12px;
    }
    .metric-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .metric-value {
      font-size: 22px;
      font-weight: 750;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(300px, 0.7fr);
      gap: 14px;
      align-items: start;
    }
    .panel {
      overflow: hidden;
    }
    .panel-head {
      min-height: 48px;
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      background: #fbfcfd;
    }
    .panel-body { padding: 12px 14px; }
    .timeline {
      display: grid;
      gap: 10px;
    }
    .event {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 10px;
      border-bottom: 1px solid #edf1f5;
      padding-bottom: 10px;
    }
    .event:last-child { border-bottom: 0; padding-bottom: 0; }
    .event-index {
      height: 30px;
      border-radius: 6px;
      background: #edf1f5;
      color: #344153;
      display: grid;
      place-items: center;
      font-weight: 700;
    }
    .event-type {
      font-weight: 700;
      margin-bottom: 3px;
    }
    .list {
      display: grid;
      gap: 9px;
    }
    .item {
      border: 1px solid #edf1f5;
      border-radius: 8px;
      padding: 10px;
      background: #fff;
      min-width: 0;
    }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
      color: #172033;
    }
    .risk-card.high { border-color: #f0b4ae; background: var(--risk-soft); }
    .risk-card.medium { border-color: #efd08c; background: var(--warn-soft); }
    .empty {
      color: var(--muted);
      padding: 14px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: #fbfcfd;
    }
    .tabs {
      display: flex;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfd;
    }
    .tab {
      border: 1px solid transparent;
      background: transparent;
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      color: var(--muted);
    }
    .tab.active {
      background: var(--panel);
      color: var(--ink);
      border-color: var(--line);
      box-shadow: var(--shadow);
    }
    .hidden { display: none; }
    @media (max-width: 980px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .header { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div>
          <h1>AgentOps Workbench</h1>
          <p class="subtle">Local SQLite dashboard</p>
        </div>
        <button class="refresh" id="refresh" title="Refresh sessions">↻</button>
      </div>
      <div class="sessions" id="sessions"></div>
    </aside>
    <main class="main">
      <section class="header">
        <div>
          <h2 id="session-heading">No session selected</h2>
          <p class="subtle" id="session-task">Ingest a session, then refresh this dashboard.</p>
          <div class="meta" id="session-meta"></div>
        </div>
      </section>
      <section class="metric-grid" id="metrics"></section>
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h3>Timeline</h3>
            <span class="subtle" id="timeline-count"></span>
          </div>
          <div class="panel-body"><div class="timeline" id="timeline"></div></div>
        </div>
        <div class="panel">
          <div class="tabs">
            <button class="tab active" data-tab="risks">Risks</button>
            <button class="tab" data-tab="commands">Commands</button>
            <button class="tab" data-tab="files">Files</button>
          </div>
          <div class="panel-body" id="tab-risks"></div>
          <div class="panel-body hidden" id="tab-commands"></div>
          <div class="panel-body hidden" id="tab-files"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const state = { sessions: [], selectedId: null, detail: null };
    const fmt = new Intl.NumberFormat("en-US");

    document.getElementById("refresh").addEventListener("click", loadSessions);
    for (const tab of document.querySelectorAll(".tab")) {
      tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    }

    loadSessions();

    async function loadSessions() {
      const response = await fetch("/api/sessions?limit=50");
      const payload = await response.json();
      state.sessions = payload.sessions || [];
      if (!state.selectedId && state.sessions.length) state.selectedId = state.sessions[0].id;
      renderSessions();
      if (state.selectedId) await loadSession(state.selectedId);
      if (!state.sessions.length) renderEmpty();
    }

    async function loadSession(id) {
      state.selectedId = id;
      renderSessions();
      const response = await fetch("/api/sessions/" + encodeURIComponent(id));
      state.detail = await response.json();
      renderDetail();
    }

    function renderSessions() {
      const container = document.getElementById("sessions");
      if (!state.sessions.length) {
        container.innerHTML = '<div class="empty">No sessions found.</div>';
        return;
      }
      container.innerHTML = state.sessions.map((session) => {
        const active = session.id === state.selectedId ? " active" : "";
        return '<button class="session-button' + active + '" data-id="' + escapeAttr(session.id) + '">' +
          '<div class="session-title"><span>' + escapeHtml(session.id) + '</span><span class="pill ' + (session.riskCount ? 'risk' : 'ok') + '">' + session.riskCount + ' risks</span></div>' +
          '<div class="subtle">' + escapeHtml(session.task || "Untitled task") + '</div>' +
          '<div class="pill-row">' +
            '<span class="pill">' + escapeHtml(session.sourceAdapter || "unknown") + '</span>' +
            '<span class="pill">' + session.eventCount + ' events</span>' +
            '<span class="pill">' + session.commandCount + ' commands</span>' +
          '</div>' +
        '</button>';
      }).join("");
      for (const button of container.querySelectorAll(".session-button")) {
        button.addEventListener("click", () => loadSession(button.dataset.id));
      }
    }

    function renderEmpty() {
      document.getElementById("metrics").innerHTML = "";
      document.getElementById("timeline").innerHTML = '<div class="empty">No sessions found. Run agentops ingest first.</div>';
      document.getElementById("tab-risks").innerHTML = '<div class="empty">No risk data.</div>';
      document.getElementById("tab-commands").innerHTML = '<div class="empty">No commands.</div>';
      document.getElementById("tab-files").innerHTML = '<div class="empty">No file changes.</div>';
    }

    function renderDetail() {
      const data = state.detail;
      const session = data.session;
      document.getElementById("session-heading").textContent = session.id;
      document.getElementById("session-task").textContent = session.task || "Untitled task";
      document.getElementById("session-meta").innerHTML = [
        session.source_adapter || "unknown adapter",
        session.agent || "unknown agent",
        session.model || "unknown model",
        session.repo || "unknown repo"
      ].map((value) => '<span class="pill">' + escapeHtml(value) + '</span>').join("");
      document.getElementById("metrics").innerHTML = [
        metric("Events", data.events.length),
        metric("Commands", data.commands.length),
        metric("Files", data.files.length),
        metric("Risks", data.risks.length),
        metric("Verification", data.verification.length),
        metric("Tokens", data.usage.totalTokens == null ? "—" : fmt.format(data.usage.totalTokens))
      ].join("");
      document.getElementById("timeline-count").textContent = data.events.length + " events";
      renderTimeline(data.events);
      renderRisks(data.risks, data.verification);
      renderCommands(data.commands);
      renderFiles(data.files);
    }

    function renderTimeline(events) {
      const container = document.getElementById("timeline");
      if (!events.length) {
        container.innerHTML = '<div class="empty">No events recorded.</div>';
        return;
      }
      container.innerHTML = events.map((event) =>
        '<div class="event">' +
          '<div class="event-index">' + event.idx + '</div>' +
          '<div><div class="event-type">' + escapeHtml(event.type) + (event.role ? ' <span class="subtle">(' + escapeHtml(event.role) + ')</span>' : '') + '</div>' +
          '<div class="subtle">' + escapeHtml(event.summary) + '</div></div>' +
        '</div>'
      ).join("");
    }

    function renderRisks(risks, verification) {
      const container = document.getElementById("tab-risks");
      const riskHtml = risks.length
        ? '<div class="list">' + risks.map((risk) => '<div class="item risk-card ' + escapeAttr(risk.severity) + '"><strong>' + escapeHtml(risk.severity + " / " + risk.category) + '</strong><div>' + escapeHtml(risk.message) + '</div></div>').join("") + '</div>'
        : '<div class="empty">No risk flags detected.</div>';
      const evidenceHtml = verification.length
        ? '<h3 style="margin:14px 0 8px">Verification Evidence</h3><div class="list">' + verification.map((command) => '<div class="item"><code>' + escapeHtml(command.command) + '</code><div class="subtle">' + escapeHtml(command.status || "unknown") + formatExit(command.exitCode) + '</div></div>').join("") + '</div>'
        : '<h3 style="margin:14px 0 8px">Verification Evidence</h3><div class="empty">No verification command recorded.</div>';
      container.innerHTML = riskHtml + evidenceHtml;
    }

    function renderCommands(commands) {
      const container = document.getElementById("tab-commands");
      container.innerHTML = commands.length
        ? '<div class="list">' + commands.map((command) => '<div class="item"><code>' + escapeHtml(command.command) + '</code><div class="subtle">' + escapeHtml(command.status || "unknown") + formatExit(command.exitCode) + '</div></div>').join("") + '</div>'
        : '<div class="empty">No commands recorded.</div>';
    }

    function renderFiles(files) {
      const container = document.getElementById("tab-files");
      container.innerHTML = files.length
        ? '<div class="list">' + files.map((file) => '<div class="item"><code>' + escapeHtml(file.path) + '</code><div class="subtle">' + escapeHtml(file.operation) + formatChurn(file) + '</div></div>').join("") + '</div>'
        : '<div class="empty">No file changes recorded.</div>';
    }

    function selectTab(name) {
      for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.tab === name);
      for (const id of ["risks", "commands", "files"]) document.getElementById("tab-" + id).classList.toggle("hidden", id !== name);
    }

    function metric(label, value) {
      return '<div class="metric"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(String(value)) + '</div></div>';
    }

    function formatExit(exitCode) {
      return exitCode == null ? "" : ", exit " + exitCode;
    }

    function formatChurn(file) {
      const parts = [];
      if (file.linesAdded != null) parts.push("+" + file.linesAdded);
      if (file.linesRemoved != null) parts.push("-" + file.linesRemoved);
      return parts.length ? " (" + parts.join(" / ") + ")" : "";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }
  </script>
</body>
</html>`;
}
