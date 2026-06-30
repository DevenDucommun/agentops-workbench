import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { adapters, detectAdapters, loadAdapterInput, resolveAdapter } from "./adapters";
import { analyzeSession } from "./analyzer";
import { defaultConfig, formatConfigValidationResult, loadConfig, validateConfigFile } from "./config";
import { captureUsage, formatCaptureResult, parseCaptureArgs, runCapture } from "./capture";
import { generateRepoJsonExport, generateSessionJsonExport } from "./export";
import { evaluateQualityGate, formatGateGithub, formatGateJson, formatGateText } from "./gate";
import { getGitChanges } from "./git";
import { formatAdapterList, generateSessionInspection, generateSessionList, noSessionsMessage } from "./inspect";
import { formatPublicationScanResult, scanPublication } from "./publicationScan";
import { generateGithubRepoComment, generateMarkdownRepoReport, generateMarkdownReport } from "./report";
import { getCommands, getFileChanges, getRiskFlags, getSessionId, ingestTranscript, listSessions, openStore, type Store } from "./store";
import { startDashboardServer, type DashboardServer } from "./dashboard";
import { startMcpStdio } from "./mcp";

type CliResult = {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  keepAlive?: Promise<void>;
  cleanup?: () => void;
};

export async function runCli(argv: string[]): Promise<CliResult> {
  const [command, ...args] = argv;
  try {
    if (!command || command === "--help" || command === "-h") {
      return { stdout: help(), exitCode: 0 };
    }

    if (command === "doctor") {
      return runDoctor(args);
    }

    if (command === "init") {
      return runInit(args);
    }

    if (command === "demo") {
      return runDemo(args);
    }

    if (command === "audit") {
      return runAudit(args);
    }

    if (command === "pr") {
      return runPr(args);
    }

    if (command === "mcp") {
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      return { exitCode: 0, keepAlive: startMcpStdio({ configPath }) };
    }

    if (command === "run") {
      if (args[0] !== "codex" && args[0] !== "claude") {
        return { stderr: "Usage: agentops run codex|claude <prompt>\n", exitCode: 1 };
      }
      const captureArgs = args.includes("--ingest") || args.includes("--dry-run") ? args : [...args, "--ingest"];
      const request = parseCaptureArgs(captureArgs);
      const result = await runCapture(request);
      let stdout = formatCaptureResult(result, { next: request.ingest && !result.dryRun ? "review" : "import" });
      if (request.ingest && !result.dryRun) {
        stdout += "\n" + ingestArtifact(result.outputPath, result.adapterId);
        stdout += "Next: agentops review\nNext: agentops dashboard\n";
      }
      const stderr = result.stderr.trim().length > 0 ? result.stderr : undefined;
      return { stdout, stderr, exitCode: 0 };
    }

    if (command === "capture") {
      const request = parseCaptureArgs(args);
      const result = await runCapture(request);
      let stdout = formatCaptureResult(result);
      if (request.ingest && !result.dryRun) {
        stdout += "\n" + ingestArtifact(result.outputPath, result.adapterId);
      }
      const stderr = result.stderr.trim().length > 0 ? result.stderr : undefined;
      return { stdout, stderr, exitCode: 0 };
    }

    if (command === "ingest" || command === "import") {
      const sourcePath = args[0];
      if (!sourcePath) return { stderr: `Usage: agentops ${command} <session.jsonl|transcript.txt>\n`, exitCode: 1 };
      if (isDatabasePath(sourcePath)) {
        return {
          stderr:
            `agentops ${command} expects a session artifact or transcript, not the SQLite database.\n\n` +
            "Use one of these instead:\n" +
            "  agentops sessions\n" +
            "  agentops review\n" +
            "  agentops report latest --out report.md\n",
          exitCode: 1
        };
      }

      const adapterId = readOption(args, "--adapter");
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const config = loadConfig(configPath);
      const input = loadAdapterInput(sourcePath);
      const adapter = resolveAdapter(input, adapterId ?? undefined);
      const store = openStore();
      const result = ingestInput(store, input, adapter.id, config);
      const stdout = formatIngestResult(store, result.sessionId, result.eventCount, adapter.id);
      store.db.close();

      return {
        stdout,
        exitCode: 0
      };
    }

    if (command === "adapters") {
      const sourcePath = readOption(args, "--input");
      if (!sourcePath) return { stdout: formatAdapterList(adapters), exitCode: 0 };

      const input = loadAdapterInput(sourcePath);
      const rows = detectAdapters(input).map(({ adapter, detection }) => ({
        id: adapter.id,
        displayName: detection.matched ? `${adapter.displayName} (${Math.round(detection.confidence * 100)}%)` : adapter.displayName,
        artifactHint: detection.reason
      }));
      return { stdout: formatAdapterList(rows), exitCode: 0 };
    }

    if (command === "config") {
      if (!args.includes("--check")) {
        return { stderr: "Usage: agentops config --check [--config agentops.config.json]\n", exitCode: 1 };
      }
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const result = validateConfigFile(configPath);
      const output = formatConfigValidationResult(result);
      return result.errors.length ? { stderr: output, exitCode: 1 } : { stdout: output, exitCode: 0 };
    }

    if (command === "sessions") {
      const limit = Number(readOption(args, "--limit") ?? "20");
      if (!Number.isInteger(limit) || limit < 1) return { stderr: "Usage: agentops sessions --limit <positive-number>\n", exitCode: 1 };
      const store = openStore();
      const output = generateSessionList(store, limit);
      store.db.close();
      return { stdout: output, exitCode: 0 };
    }

    if (command === "review") {
      const sessionArg = readSessionArg(args);
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const format = readOption(args, "--format") ?? (readOption(args, "--out") ? "markdown" : "inspect");
      const outPath = readOption(args, "--out");
      if (!["inspect", "markdown", "github", "json"].includes(format)) {
        return { stderr: "Usage: agentops review [latest|session-id] [--format inspect|markdown|github|json] [--out file]\n", exitCode: 1 };
      }
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: noSessionsMessage(), exitCode: 1 };
      }
      const output =
        format === "inspect"
          ? generateSessionInspection(store, sessionId, config)
          : format === "github"
            ? generateGithubRepoComment(store, sessionId, getGitChanges(), config)
            : format === "json"
              ? generateSessionJsonExport(store, sessionId, config)
              : generateMarkdownReport(store, sessionId, config);
      store.db.close();
      return outputResult(output, outPath, format === "json" ? "JSON export" : format === "github" ? "PR comment" : "review");
    }

    if (command === "inspect") {
      const sessionArg = readSessionArg(args);
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: noSessionsMessage(), exitCode: 1 };
      }
      const output = generateSessionInspection(store, sessionId, config);
      store.db.close();
      return { stdout: output, exitCode: 0 };
    }

    if (command === "report") {
      const sessionArg = readSessionArg(args);
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const outPath = readOption(args, "--out");
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: noSessionsMessage(), exitCode: 1 };
      }
      const report = generateMarkdownReport(store, sessionId, config);
      store.db.close();
      return outputResult(report, outPath, "report");
    }

    if (command === "repo-report") {
      const sessionArg = readSessionArg(args);
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const format = readOption(args, "--format") ?? "markdown";
      const outPath = readOption(args, "--out");
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: noSessionsMessage(), exitCode: 1 };
      }
      if (!["markdown", "github"].includes(format)) {
        store.db.close();
        return { stderr: "Usage: agentops repo-report --format markdown|github\n", exitCode: 1 };
      }
      const report =
        format === "github"
          ? generateGithubRepoComment(store, sessionId, getGitChanges(), config)
          : generateMarkdownRepoReport(store, sessionId, getGitChanges(), config);
      store.db.close();
      return outputResult(report, outPath, format === "github" ? "PR comment" : "repo report");
    }

    if (command === "export") {
      const sessionArg = readSessionArg(args);
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const format = readOption(args, "--format") ?? "json";
      const scope = readOption(args, "--scope") ?? "session";
      const outPath = readOption(args, "--out");
      const includeRawPayloads = args.includes("--include-raw-payloads");
      if (format !== "json" || !["session", "repo"].includes(scope)) {
        return { stderr: "Usage: agentops export --session latest --format json [--scope session|repo]\n", exitCode: 1 };
      }

      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: noSessionsMessage(), exitCode: 1 };
      }
      const output =
        scope === "repo"
          ? generateRepoJsonExport(store, sessionId, getGitChanges(), config, { includeRawPayloads })
          : generateSessionJsonExport(store, sessionId, config, { includeRawPayloads });
      store.db.close();
      return outputResult(output, outPath, "JSON export");
    }

    if (command === "gate") {
      const sessionArg = readSessionArg(args);
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const format = readOption(args, "--format") ?? "text";
      const outPath = readOption(args, "--out");
      if (!["text", "json", "github"].includes(format)) {
        return { stderr: "Usage: agentops gate [latest|session-id] [--format text|json|github] [--out file]\n", exitCode: 1 };
      }
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: noSessionsMessage(), exitCode: 1 };
      }
      const result = evaluateQualityGate(store, sessionId, config, { gitChanges: getGitChangesOrEmpty() });
      store.db.close();
      const output = format === "json" ? formatGateJson(result) : format === "github" ? formatGateGithub(result) : formatGateText(result);
      const written = outputResult(output, outPath, format === "github" ? "quality gate PR comment" : "quality gate");
      return { ...written, exitCode: result.status === "passed" ? 0 : 1 };
    }

    if (command === "dashboard") {
      if (args.includes("--check")) {
        const host = readOption(args, "--host") ?? "127.0.0.1";
        const port = parsePort(readOption(args, "--port"));
        const store = openStore();
        const databasePath = store.path;
        store.db.close();
        return {
          stdout: `Dashboard configuration OK\nHost: ${host}\nPort: ${port}\nDatabase: ${databasePath}\n`,
          exitCode: 0
        };
      }

      const host = readOption(args, "--host") ?? "127.0.0.1";
      const port = parsePort(readOption(args, "--port"));
      const server = startDashboardServer({ host, port });
      return {
        stdout: `AgentOps dashboard listening at ${server.url}\nPress Ctrl+C to stop.\n`,
        exitCode: 0,
        keepAlive: waitForShutdown(server)
      };
    }

    if (command === "scan-publication") {
      const findings = scanPublication();
      const output = formatPublicationScanResult(findings);
      if (findings.length > 0) {
        return { stderr: output, exitCode: 1 };
      }
      return { stdout: output, exitCode: 0 };
    }

    if (looksLikeOutputPath(command)) {
      return {
        stderr:
          `Unknown command: ${command}\n\n` +
          "It looks like that is an output filename. Use:\n" +
          `  agentops report latest --out ${command}\n\n` +
          "Or write to stdout with shell redirection:\n" +
          `  agentops report --session latest > ${command}\n`,
        exitCode: 1
      };
    }

    return { stderr: `Unknown command: ${command}\n\n${help()}`, exitCode: 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stderr: `${message}\n`, exitCode: 1 };
  }
}

function readSessionArg(args: string[]): string {
  const explicit = readOption(args, "--session");
  if (explicit) return explicit;
  const optionNamesWithValues = new Set(["--session", "--config", "--format", "--scope", "--out", "--port", "--host"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (optionNamesWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    const positional = arg;
    if (!positional.includes(".")) return positional;
  }
  return "latest";
}

function outputResult(output: string, outPath: string | null, label: string): CliResult {
  if (!outPath) return { stdout: output, exitCode: 0 };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  return { stdout: `Wrote ${label}: ${outPath}\n`, exitCode: 0 };
}

function isDatabasePath(path: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(path);
}

function looksLikeOutputPath(value: string): boolean {
  return /\.(md|json|txt)$/i.test(value);
}

function parsePort(value: string | null): number {
  if (value === null) return 4927;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Usage: agentops dashboard --port <1-65535>");
  }
  return parsed;
}

function waitForShutdown(server: DashboardServer): Promise<void> {
  return new Promise((resolve) => {
    let stopped = false;
    const keepAlive = setInterval(() => undefined, 60_000);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(keepAlive);
      server.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

type DoctorCheck = ReturnType<typeof doctorCheck>;

type SetupResult = {
  label: string;
  status: "ok" | "created" | "updated" | "failed";
  detail: string;
};

function runDoctor(args: string[]): CliResult {
  const configPath = readOption(args, "--config") ?? "agentops.config.json";
  const fixResults = args.includes("--fix") ? applySetupFixes(configPath) : [];
  const state = collectDoctorState(configPath);
  const setupOk = fixResults.every((result) => result.status !== "failed");
  const lines = [
    "# AgentOps Doctor",
    "",
    ...(fixResults.length ? ["Safe fixes:", ...fixResults.map(formatSetupResult), ""] : []),
    ...formatDoctorState(state)
  ];
  return { stdout: lines.join("\n"), exitCode: state.ok && setupOk ? 0 : 1 };
}

function runInit(args: string[]): CliResult {
  const configPath = readOption(args, "--config") ?? "agentops.config.json";
  const setupResults = applySetupFixes(configPath);
  const state = collectDoctorState(configPath);
  const setupOk = setupResults.every((result) => result.status !== "failed");
  const lines = [
    "# AgentOps Init",
    "",
    "Setup:",
    ...setupResults.map(formatSetupResult),
    "",
    "Readiness:",
    ...state.checks.map(formatDoctorCheck),
    "",
    "Recommended next command:",
    `  ${state.next}`,
    ""
  ];
  return { stdout: lines.join("\n"), exitCode: state.ok && setupOk ? 0 : 1 };
}

function collectDoctorState(configPath: string): { checks: DoctorCheck[]; ok: boolean; next: string } {
  const configResult = validateConfigFile(configPath);
  const store = openStore();
  const sessions = listSessions(store, 1);
  const databasePath = store.path;
  store.db.close();
  const codexAvailable = commandAvailable("codex");
  const claudeAvailable = commandAvailable("claude");
  const agentOpsIgnored = isAgentOpsIgnored();

  const checks = [
    doctorCheck("Bun runtime", true, `bun ${Bun.version}`),
    doctorCheck("Git checkout", existsSync(".git"), existsSync(".git") ? ".git found" : ".git not found; repo-aware reports need a git checkout"),
    doctorCheck(".agentops ignore", agentOpsIgnored, agentOpsIgnored ? ".agentops/ is ignored" : ".agentops/ is not ignored", "error"),
    doctorCheck(
      "Config",
      configResult.errors.length === 0,
      configResult.errors.length === 0 ? (configResult.exists ? `${configResult.path} OK` : "using built-in defaults") : configResult.errors.join("; "),
      "error"
    ),
    doctorCheck("SQLite store", true, databasePath),
    doctorCheck("Codex CLI", codexAvailable, codexAvailable ? "available on PATH" : "not found on PATH"),
    doctorCheck("Claude CLI", claudeAvailable, claudeAvailable ? "available on PATH" : "not found on PATH"),
    doctorCheck("Stored sessions", true, `${sessions.length > 0 ? "at least one" : "none"} found`)
  ];
  const ok = checks.every((check) => check.ok || check.level === "warn");
  const next = sessions.length > 0 ? "agentops review" : "agentops demo";
  return { checks, ok, next };
}

function formatDoctorState(state: { checks: DoctorCheck[]; next: string }): string[] {
  return [
    ...state.checks.map(formatDoctorCheck),
    "",
    "Recommended next command:",
    `  ${state.next}`,
    ""
  ];
}

function runDemo(args: string[]): CliResult {
  const configPath = readOption(args, "--config") ?? "agentops.config.json";
  const host = readOption(args, "--host") ?? "127.0.0.1";
  const port = parsePort(readOption(args, "--port"));
  const dashboardUrl = `http://${host}:${port}`;
  const config = loadConfig(configPath);
  const store = openStore();
  const fixtures = [
    ["fixtures/sample-session.jsonl", "ready"],
    ["fixtures/needs-review-session.jsonl", "needs review"],
    ["fixtures/risky-session.jsonl", "blocked"],
    ["fixtures/forensic-terminal-transcript.txt", "forensic"]
  ] as const;
  const imported = fixtures.map(([sourcePath, state]) => {
    const input = loadAdapterInput(sourcePath);
    const adapter = resolveAdapter(input);
    const result = ingestInput(store, input, adapter.id, config);
    return { ...result, adapterId: adapter.id, state };
  });
  const sampleGate = evaluateQualityGate(store, "sample-session", config, { gitChanges: [] });
  store.db.close();
  const server = args.includes("--serve") ? startDashboardServer({ host, port }) : null;

  const lines = [
    "# AgentOps Demo",
    "",
    "Imported synthetic sessions:",
    ...imported.map((item) => `- ${item.sessionId} (${item.state}, ${item.adapterId}, ${item.eventCount} events)`),
    "",
    `Sample gate: ${sampleGate.status.toUpperCase()} - ${sampleGate.summary}`,
    "",
    "Next commands:",
    "  agentops review sample-session",
    "  agentops gate sample-session",
    `  agentops dashboard --host ${host} --port ${port}`,
    `Dashboard URL: ${dashboardUrl}`,
    ...(server ? ["", `Dashboard listening at ${server.url}`, "Press Ctrl+C to stop."] : []),
    "",
    "Static demo artifacts: docs/demo/",
    ""
  ];
  return server ? { stdout: lines.join("\n"), exitCode: 0, keepAlive: waitForShutdown(server) } : { stdout: lines.join("\n"), exitCode: 0 };
}

function runAudit(args: string[]): CliResult {
  const sourcePath = args[0];
  if (!sourcePath) return { stderr: "Usage: agentops audit <session.jsonl|transcript.txt> [--out audit.md]\n", exitCode: 1 };
  if (isDatabasePath(sourcePath)) {
    return { stderr: "agentops audit expects a session artifact or transcript, not the SQLite database.\n", exitCode: 1 };
  }

  const adapterId = readOption(args, "--adapter");
  const configPath = readOption(args, "--config") ?? "agentops.config.json";
  const outPath = readOption(args, "--out");
  const config = loadConfig(configPath);
  const input = loadAdapterInput(sourcePath);
  const adapter = resolveAdapter(input, adapterId ?? undefined);
  const store = openStore();
  const result = ingestInput(store, input, adapter.id, config);
  const importSummary = formatAuditImportSummary(result.sessionId, result.eventCount, adapter.id);
  const review = generateSessionInspection(store, result.sessionId, config);
  const gate = evaluateQualityGate(store, result.sessionId, config, { gitChanges: getGitChangesOrEmpty() });
  const gateText = formatGateText(gate);
  store.db.close();

  const output = ["# AgentOps Audit", "", importSummary.trim(), "", review.trim(), "", gateText.trim(), ""].join("\n");
  const written = outputResult(output, outPath, "audit");
  return { ...written, exitCode: gate.status === "passed" ? 0 : 1 };
}

function runPr(args: string[]): CliResult {
  const sessionArg = readSessionArg(args);
  const configPath = readOption(args, "--config") ?? "agentops.config.json";
  const outPath = readOption(args, "--out");
  const config = loadConfig(configPath);
  const store = openStore();
  const sessionId = getSessionId(store, sessionArg);
  if (!sessionId) {
    store.db.close();
    return { stderr: noSessionsMessage(), exitCode: 1 };
  }
  const output = generateGithubRepoComment(store, sessionId, getGitChanges(), config);
  store.db.close();
  return outputResult(output, outPath, "PR comment");
}

function ingestArtifact(sourcePath: string, adapterId: string): string {
  const config = loadConfig("agentops.config.json");
  const input = loadAdapterInput(sourcePath);
  const adapter = resolveAdapter(input, adapterId);
  const store = openStore();
  const result = ingestInput(store, input, adapter.id, config);
  const output = formatIngestResult(store, result.sessionId, result.eventCount, adapter.id);
  store.db.close();

  return output;
}

function formatAuditImportSummary(sessionId: string, eventCount: number, adapterId: string): string {
  return [`Ingested session ${sessionId} (${eventCount} events)`, `Adapter: ${adapterId}`].join("\n");
}

function ingestInput(store: Store, input: ReturnType<typeof loadAdapterInput>, adapterId: string, config: ReturnType<typeof loadConfig>) {
  const adapter = resolveAdapter(input, adapterId);
  const transcript = adapter.parse(input, config);
  const result = ingestTranscript(store, transcript, config);
  analyzeSession(store, result.sessionId, config);
  return result;
}

function doctorCheck(label: string, ok: boolean, detail: string, level: "error" | "warn" = "warn") {
  return { label, ok, detail, level };
}

function formatDoctorCheck(check: DoctorCheck): string {
  return `- ${check.ok ? "PASS" : check.level === "warn" ? "WARN" : "FAIL"} ${check.label}: ${check.detail}`;
}

function formatSetupResult(result: SetupResult): string {
  return `- ${result.status.toUpperCase()} ${result.label}: ${result.detail}`;
}

function applySetupFixes(configPath: string): SetupResult[] {
  return [ensureAgentOpsDirectory(), ensureAgentOpsGitignore(), ensureDefaultConfig(configPath)];
}

function ensureAgentOpsDirectory(): SetupResult {
  try {
    mkdirSync(".agentops", { recursive: true });
    return { label: ".agentops directory", status: "ok", detail: ".agentops/ is present" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { label: ".agentops directory", status: "failed", detail: reason };
  }
}

function ensureAgentOpsGitignore(): SetupResult {
  const path = ".gitignore";
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (hasAgentOpsIgnoreEntry(current)) {
      return { label: ".gitignore", status: "ok", detail: ".agentops/ already ignored" };
    }
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${current}${separator}.agentops/\n`);
    return { label: ".gitignore", status: existsSync(path) && current.length > 0 ? "updated" : "created", detail: "added .agentops/" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { label: ".gitignore", status: "failed", detail: reason };
  }
}

function ensureDefaultConfig(configPath: string): SetupResult {
  if (existsSync(configPath)) {
    return { label: "Config", status: "ok", detail: `${configPath} already exists` };
  }
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
    return { label: "Config", status: "created", detail: configPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { label: "Config", status: "failed", detail: reason };
  }
}

function hasAgentOpsIgnoreEntry(content: string): boolean {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".agentops/" || line === ".agentops");
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0;
}

function isAgentOpsIgnored(): boolean {
  if (!existsSync(".git")) return true;
  const result = spawnSync("git", ["check-ignore", "-q", ".agentops/"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0;
}

function getGitChangesOrEmpty() {
  try {
    return getGitChanges();
  } catch {
    return [];
  }
}

function formatIngestResult(store: Store, sessionId: string, eventCount: number, adapterId: string): string {
  const lines = [`Ingested session ${sessionId} (${eventCount} events)`, `Adapter: ${adapterId}`, `Database: ${store.path}`];
  if (adapterId === "forensic-text") {
    const commands = getCommands(store, sessionId);
    const files = getFileChanges(store, sessionId);
    const risks = getRiskFlags(store, sessionId);
    const observedCommands = commands.filter((command) => command.status === "observed").length;
    const inferredCommands = commands.filter((command) => command.status === "inferred").length;
    const inferredFiles = files.filter((file) => file.operation.startsWith("inferred")).length;
    const weak = risks.some((risk) => risk.category === "weak-forensic-transcript");
    lines.push(`Evidence quality: ${weak ? "weak forensic text" : "forensic text"}`);
    lines.push(`Observed commands: ${observedCommands}`);
    lines.push(`Inferred commands: ${inferredCommands}`);
    lines.push(`Inferred files: ${inferredFiles}`);
    lines.push(
      weak
        ? "Warning: transcript has no observable shell commands, so verification evidence is missing."
        : "Warning: plain-text import may include inferred evidence. Prefer agentops run or provider JSONL for full-fidelity audit."
    );
    lines.push(`Next: agentops review ${sessionId}`);
  }
  return `${lines.join("\n")}\n`;
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function help(): string {
  return `AgentOps Workbench

Usage:
  agentops init
  agentops doctor
  agentops doctor --fix
  agentops demo
  agentops demo --serve
  agentops run codex <prompt>
  agentops run claude <prompt>
  agentops audit <session.jsonl|transcript.txt>
  agentops review [latest|session-id]
  agentops pr [latest|session-id] [--out pr-comment.md]
  agentops dashboard
  agentops mcp

Advanced:
  agentops capture codex <prompt> [--output .agentops/captures/codex.jsonl] [--ingest]
  agentops capture claude <prompt> [--output .agentops/captures/claude.jsonl] [--ingest]
  agentops import <session.jsonl|transcript.txt>
  agentops ingest <session.jsonl|transcript.txt>
  agentops report latest --out report.md
  agentops export latest --format json
  agentops gate latest
  agentops gate latest --format json --out agentops-gate.json
  agentops repo-report latest
  agentops repo-report latest --format github
  agentops adapters
  agentops adapters --input <session.jsonl>
  agentops config --check
  agentops sessions
  agentops inspect latest
  agentops scan-publication

Capture:
  ${captureUsage("codex")}
  ${captureUsage("claude")}

Adapters:
${adapters.map((adapter) => `  ${adapter.id}  ${adapter.displayName}`).join("\n")}

Environment:
  AGENTOPS_DB  Path to SQLite database. Defaults to .agentops/agentops.db
`;
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.keepAlive) {
    await result.keepAlive;
  }
  result.cleanup?.();
  process.exit(result.exitCode);
}
