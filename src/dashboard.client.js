
    const state = { sessions: [], selectedId: null, detail: null, filterText: "", adapterFilter: "", compareId: "" };
    const fmt = new Intl.NumberFormat("en-US");

    document.getElementById("refresh").addEventListener("click", loadSessions);
    document.getElementById("session-filter").addEventListener("input", (event) => {
      state.filterText = event.target.value;
      renderSessions();
    });
    document.getElementById("adapter-filter").addEventListener("change", (event) => {
      state.adapterFilter = event.target.value;
      renderSessions();
    });
    document.getElementById("compare-select").addEventListener("change", async (event) => {
      state.compareId = event.target.value;
      if (state.compareId) await loadComparison();
      else renderComparison(null);
    });
    for (const tab of document.querySelectorAll(".tab")) {
      tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    }

    loadSessions();

    async function loadSessions() {
      const response = await fetch("/api/sessions?limit=50");
      const payload = await response.json();
      state.sessions = payload.sessions || [];
      if (!state.selectedId && state.sessions.length) state.selectedId = state.sessions[0].id;
      renderFilters();
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
      const sessions = filteredSessions();
      if (!sessions.length) {
        container.innerHTML = '<div class="empty">No matching sessions.</div>';
        return;
      }
      container.innerHTML = sessions.map((session) => {
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

    function renderFilters() {
      const select = document.getElementById("adapter-filter");
      const adapters = Array.from(new Set(state.sessions.map((session) => session.sourceAdapter || "unknown"))).sort();
      select.innerHTML = '<option value="">All adapters</option>' + adapters.map((adapter) => '<option value="' + escapeAttr(adapter) + '">' + escapeHtml(adapter) + '</option>').join("");
      select.value = adapters.includes(state.adapterFilter) ? state.adapterFilter : "";
      state.adapterFilter = select.value;
    }

    function filteredSessions() {
      const query = state.filterText.trim().toLowerCase();
      return state.sessions.filter((session) => {
        const adapter = session.sourceAdapter || "unknown";
        if (state.adapterFilter && adapter !== state.adapterFilter) return false;
        if (!query) return true;
        return [
          session.id,
          session.task,
          session.agent,
          session.model,
          session.repo,
          adapter
        ].some((value) => String(value || "").toLowerCase().includes(query));
      });
    }

    function renderEmpty() {
      document.getElementById("metrics").innerHTML = "";
      document.getElementById("decision").innerHTML = "";
      renderComparison(null);
      document.getElementById("timeline").innerHTML = '<div class="empty">No sessions found. Run agentops run or agentops audit first.</div>';
      document.getElementById("quality").innerHTML = "";
      document.getElementById("tab-risks").innerHTML = '<div class="empty">No risk data.</div>';
      document.getElementById("tab-tools").innerHTML = '<div class="empty">No tool calls.</div>';
      document.getElementById("tab-commands").innerHTML = '<div class="empty">No commands.</div>';
      document.getElementById("tab-files").innerHTML = '<div class="empty">No file changes.</div>';
      document.getElementById("report-link").classList.add("hidden");
      document.getElementById("evidence-link").classList.add("hidden");
      document.getElementById("compare-select").classList.add("hidden");
    }

    function renderDetail() {
      const data = state.detail;
      const session = data.session;
      const reportLink = document.getElementById("report-link");
      reportLink.href = "/api/sessions/" + encodeURIComponent(session.id) + "/report";
      reportLink.classList.remove("hidden");
      const evidenceLink = document.getElementById("evidence-link");
      evidenceLink.href = "/api/sessions/" + encodeURIComponent(session.id) + "/evidence";
      evidenceLink.classList.remove("hidden");
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
        metric("Tools", data.tools.length),
        metric("Risks", data.risks.length),
        metric("Verification", data.verification.length),
        metric("Tokens", data.usage.totalTokens == null ? "—" : fmt.format(data.usage.totalTokens))
      ].join("");
      renderEvidenceQuality(data.evidenceQuality);
      renderDecision(data.decision);
      renderCompareSelect(session.id);
      if (state.compareId) loadComparison();
      else renderComparison(null);
      document.getElementById("timeline-count").textContent = data.events.length + " events";
      renderTimeline(data.events);
      renderRisks(data.riskDrilldown, data.verification);
      renderTools(data.tools);
      renderCommands(data.commands);
      renderFiles(data.files);
    }

    async function loadComparison() {
      if (!state.selectedId || !state.compareId) {
        renderComparison(null);
        return;
      }
      const response = await fetch("/api/compare?base=" + encodeURIComponent(state.compareId) + "&target=" + encodeURIComponent(state.selectedId));
      if (!response.ok) {
        renderComparison({ error: "Comparison unavailable." });
        return;
      }
      renderComparison(await response.json());
    }

    function renderCompareSelect(selectedId) {
      const select = document.getElementById("compare-select");
      const options = state.sessions.filter((session) => session.id !== selectedId);
      if (!options.length) {
        state.compareId = "";
        select.classList.add("hidden");
        renderComparison(null);
        return;
      }
      if (state.compareId === selectedId || !options.some((session) => session.id === state.compareId)) state.compareId = "";
      select.innerHTML = '<option value="">Compare with</option>' + options.map((session) => '<option value="' + escapeAttr(session.id) + '">' + escapeHtml(session.id) + '</option>').join("");
      select.value = state.compareId;
      select.classList.remove("hidden");
    }

    function renderComparison(comparison) {
      const container = document.getElementById("comparison");
      if (!comparison) {
        container.classList.add("hidden");
        container.innerHTML = "";
        return;
      }
      container.classList.remove("hidden");
      if (comparison.error) {
        container.innerHTML = '<div class="panel-body"><div class="empty">' + escapeHtml(comparison.error) + '</div></div>';
        return;
      }
      container.innerHTML =
        '<div class="panel-head"><h3>Run Comparison</h3><span class="subtle">' + escapeHtml(comparison.base.id) + ' to ' + escapeHtml(comparison.target.id) + '</span></div>' +
        '<div class="panel-body">' +
          '<div class="comparison-grid">' +
            comparisonMetric("Readiness", comparison.base.readiness + " to " + comparison.target.readiness, "neutral") +
            comparisonMetric("Risks", comparison.target.riskCount, deltaClass(comparison.deltas.riskCount, true), comparison.deltas.riskCount) +
            comparisonMetric("High risks", comparison.target.highRiskCount, deltaClass(comparison.deltas.highRiskCount, true), comparison.deltas.highRiskCount) +
            comparisonMetric("Verification", comparison.target.verificationCount, deltaClass(comparison.deltas.verificationCount, false), comparison.deltas.verificationCount) +
            comparisonMetric("Files", comparison.target.fileCount, deltaClass(comparison.deltas.fileCount, true), comparison.deltas.fileCount) +
            comparisonMetric("Commands", comparison.target.commandCount, deltaClass(comparison.deltas.commandCount, true), comparison.deltas.commandCount) +
            comparisonMetric("Tokens", comparison.target.totalTokens == null ? "—" : fmt.format(comparison.target.totalTokens), deltaClass(comparison.deltas.totalTokens, true), comparison.deltas.totalTokens) +
          '</div>' +
          '<div class="comparison-lists">' +
            (comparison.compatible.sameRepo ? "" : '<div class="mini-list"><h4>Compatibility</h4><div class="subtle">' + escapeHtml(comparison.compatible.message || "Sessions may not be comparable.") + '</div></div>') +
            miniList("Target-only files", comparison.files.targetOnly) +
            miniList("Target-only verification", comparison.verification.targetOnly) +
            miniList("Risk changes", comparison.risks.filter((risk) => risk.delta !== 0).map((risk) => risk.severity + " / " + risk.category + " " + formatSigned(risk.delta))) +
          '</div>' +
        '</div>';
    }

    function comparisonMetric(label, value, deltaClassName, delta) {
      const deltaHtml = delta == null ? "" : '<div class="delta ' + deltaClassName + '">' + formatSigned(delta) + '</div>';
      return '<div class="comparison-metric"><div class="metric-label">' + escapeHtml(label) + '</div><div class="comparison-value">' + escapeHtml(String(value)) + '</div>' + deltaHtml + '</div>';
    }

    function miniList(label, values) {
      const body = values.length ? '<ul>' + values.slice(0, 6).map((value) => '<li>' + escapeHtml(value) + '</li>').join("") + '</ul>' : '<div class="subtle">No changes.</div>';
      return '<div class="mini-list"><h4>' + escapeHtml(label) + '</h4>' + body + '</div>';
    }

    function deltaClass(delta, lowerIsBetter) {
      if (delta == null || delta === 0) return "neutral";
      const improved = lowerIsBetter ? delta < 0 : delta > 0;
      return improved ? "good" : "bad";
    }

    function formatSigned(value) {
      if (value == null) return "";
      return value > 0 ? "+" + value : String(value);
    }

    function renderDecision(decision) {
      const container = document.getElementById("decision");
      if (!decision) {
        container.innerHTML = "";
        return;
      }
      const readiness = decision.mergeReadiness;
      container.innerHTML =
        '<div class="panel readiness-card ' + escapeAttr(readiness.status) + '">' +
          '<div class="readiness-head">' +
            '<div><h3>Merge Readiness</h3><div class="readiness-title">' + escapeHtml(readiness.label) + '</div></div>' +
            '<span class="pill ' + readinessPillClass(readiness.status) + '">' + escapeHtml(readiness.status) + '</span>' +
          '</div>' +
          '<ul class="reason-list">' + readiness.reasons.map((reason) => '<li>' + escapeHtml(reason) + '</li>').join("") + '</ul>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3>Claim vs Evidence</h3><span class="subtle">' + decision.evidence.length + ' checks</span></div>' +
          '<div class="evidence-table">' +
            '<div class="evidence-row"><div>Check</div><div>Status</div><div>Evidence</div></div>' +
            decision.evidence.map(renderEvidenceRow).join("") +
          '</div>' +
        '</div>';
    }

    function renderEvidenceQuality(quality) {
      const container = document.getElementById("quality");
      if (!quality) {
        container.innerHTML = "";
        return;
      }
      const pillClass = quality.level === "structured" ? "ok" : quality.level === "weak-forensic" ? "risk" : "neutral";
      const counts = [
        quality.observedCommandCount + " observed commands",
        quality.inferredCommandCount + " inferred commands",
        quality.inferredFileCount + " inferred files"
      ];
      container.innerHTML =
        '<div class="panel quality-card">' +
          '<div class="quality-head"><h3>Evidence Quality</h3><span class="pill ' + pillClass + '">' + escapeHtml(quality.label) + '</span></div>' +
          '<div class="pill-row">' + counts.map((value) => '<span class="pill">' + escapeHtml(value) + '</span>').join("") + '</div>' +
          '<div class="quality-notes">' + quality.notes.map((note) => escapeHtml(note)).join(" ") + '</div>' +
        '</div>';
    }

    function renderEvidenceRow(row) {
      const detail = row.command
        ? '<code>' + escapeHtml(row.command) + '</code><div class="evidence-detail">' + escapeHtml(row.commandStatus || "unknown") + formatExit(row.commandExitCode) + '</div>'
        : row.riskMessage
          ? '<div class="evidence-detail">' + escapeHtml(row.riskMessage) + '</div>'
          : '<div class="evidence-detail">No claim recorded.</div>';
      return '<div class="evidence-row">' +
        '<div><strong>' + escapeHtml(row.label) + '</strong><div class="evidence-detail">' + (row.claimed ? 'Claimed' : 'Not claimed') + '</div></div>' +
        '<div><span class="pill ' + evidencePillClass(row.status) + '">' + escapeHtml(formatEvidenceStatus(row.status)) + '</span></div>' +
        '<div>' + detail + '</div>' +
      '</div>';
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

    function renderRisks(drilldown, verification) {
      const container = document.getElementById("tab-risks");
      const riskHtml = drilldown && drilldown.groups.length
        ? '<h3 style="margin:0 0 8px">Risk Drilldown</h3>' + renderRiskSummary(drilldown.totals) + '<div class="list">' + drilldown.groups.map(renderRiskGroup).join("") + '</div>'
        : '<div class="empty">No risk flags detected.</div>';
      const evidenceHtml = verification.length
        ? '<h3 style="margin:14px 0 8px">Verification Evidence</h3><div class="list">' + verification.map((command) => '<div class="item"><code>' + escapeHtml(command.command) + '</code><div class="subtle">' + escapeHtml(command.status || "unknown") + formatExit(command.exitCode) + '</div></div>').join("") + '</div>'
        : '<h3 style="margin:14px 0 8px">Verification Evidence</h3><div class="empty">No verification command recorded.</div>';
      container.innerHTML = riskHtml + evidenceHtml;
    }

    function renderRiskSummary(totals) {
      return '<div class="risk-summary">' +
        '<span class="pill risk">' + totals.high + ' high</span>' +
        '<span class="pill neutral">' + totals.medium + ' medium</span>' +
        '<span class="pill neutral">' + totals.low + ' low</span>' +
        '<span class="pill">' + totals.total + ' total</span>' +
      '</div>';
    }

    function renderRiskGroup(group) {
      return '<div class="risk-group ' + escapeAttr(group.severity) + '">' +
        '<div class="risk-group-head"><span>' + escapeHtml(group.severity + " / " + group.category) + '</span><span class="pill">' + group.count + '</span></div>' +
        group.risks.map(renderRiskItem).join("") +
      '</div>';
    }

    function renderRiskItem(risk) {
      return '<div class="risk-item">' +
        '<div>' + escapeHtml(risk.message) + '</div>' +
        '<div class="risk-context">' + renderRiskContext(risk) + '</div>' +
      '</div>';
    }

    function renderRiskContext(risk) {
      const rows = [];
      if (risk.event) rows.push(contextLine("Event", "#" + risk.event.idx + " " + risk.event.type + " · " + risk.event.summary));
      if (risk.command) rows.push(contextLine("Command", '<code>' + escapeHtml(risk.command.command) + '</code><div>' + escapeHtml(risk.command.status || "unknown") + formatExit(risk.command.exitCode) + '</div>', true));
      if (risk.file) rows.push(contextLine("File", '<code>' + escapeHtml(risk.file.path) + '</code><div>' + escapeHtml(risk.file.operation) + formatChurn(risk.file) + '</div>', true));
      if (risk.evidence) rows.push(contextLine("Evidence", risk.evidence.label + " · " + formatEvidenceStatus(risk.evidence.status)));
      return rows.length ? rows.join("") : contextLine("Context", "No linked event context recorded.");
    }

    function contextLine(label, value, valueIsHtml) {
      return '<div class="context-line"><div class="context-label">' + escapeHtml(label) + '</div><div>' + (valueIsHtml ? value : escapeHtml(value)) + '</div></div>';
    }

    function renderCommands(commands) {
      const container = document.getElementById("tab-commands");
      container.innerHTML = commands.length
        ? '<div class="list">' + commands.map((command) => '<div class="item"><code>' + escapeHtml(command.command) + '</code><div class="subtle">' + escapeHtml(command.status || "unknown") + formatExit(command.exitCode) + '</div></div>').join("") + '</div>'
        : '<div class="empty">No commands recorded.</div>';
    }

    function renderTools(tools) {
      const container = document.getElementById("tab-tools");
      container.innerHTML = tools.length
        ? '<div class="list">' + tools.map((tool) => '<div class="item tool-row"><div><code>' + escapeHtml(tool.toolName) + '</code><div class="tool-category">' + escapeHtml(tool.category) + (tool.status ? ' · ' + escapeHtml(tool.status) : '') + '</div></div><span class="pill">' + tool.count + '</span></div>').join("") + '</div>'
        : '<div class="empty">No tool calls recorded.</div>';
    }

    function renderFiles(files) {
      const container = document.getElementById("tab-files");
      container.innerHTML = files.length
        ? '<div class="list">' + files.map((file) => '<div class="item"><code>' + escapeHtml(file.path) + '</code><div class="subtle">' + escapeHtml(file.operation) + formatChurn(file) + '</div></div>').join("") + '</div>'
        : '<div class="empty">No file changes recorded.</div>';
    }

    function selectTab(name) {
      for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.tab === name);
      for (const id of ["risks", "tools", "commands", "files"]) document.getElementById("tab-" + id).classList.toggle("hidden", id !== name);
    }

    function metric(label, value) {
      return '<div class="metric"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(String(value)) + '</div></div>';
    }

    function readinessPillClass(status) {
      if (status === "ready") return "ok";
      if (status === "blocked") return "risk";
      return "neutral";
    }

    function evidencePillClass(status) {
      if (status === "verified") return "ok";
      if (status === "inferred-evidence") return "neutral";
      if (status === "missing-evidence") return "missing";
      return "neutral";
    }

    function formatEvidenceStatus(status) {
      if (status === "verified") return "Evidence found";
      if (status === "inferred-evidence") return "Inferred evidence";
      if (status === "missing-evidence") return "Missing evidence";
      return "Not claimed";
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
