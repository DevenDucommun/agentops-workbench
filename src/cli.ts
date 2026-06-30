import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { adapters, detectAdapters, loadAdapterInput, resolveAdapter } from "./adapters";
import { analyzeSession } from "./analyzer";
import { formatConfigValidationResult, loadConfig, validateConfigFile } from "./config";
import { captureUsage, formatCaptureResult, parseCaptureArgs, runCapture } from "./capture";
import { generateRepoJsonExport, generateSessionJsonExport } from "./export";
import { getGitChanges } from "./git";
import { formatAdapterList, generateSessionInspection, generateSessionList } from "./inspect";
import { formatPublicationScanResult, scanPublication } from "./publicationScan";
import { generateGithubRepoComment, generateMarkdownRepoReport, generateMarkdownReport } from "./report";
import { getSessionId, ingestTranscript, openStore } from "./store";
import { startDashboardServer, type DashboardServer } from "./dashboard";

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
      if (!sourcePath) return { stderr: `Usage: agentops ${command} <session.jsonl>\n`, exitCode: 1 };
      if (isDatabasePath(sourcePath)) {
        return {
          stderr:
            `agentops ${command} expects a JSONL session artifact, not the SQLite database.\n\n` +
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
      const transcript = adapter.parse(input, config);
      const result = ingestTranscript(store, transcript, config);
      analyzeSession(store, result.sessionId, config);
      store.db.close();

      return {
        stdout: `Ingested session ${result.sessionId} (${result.eventCount} events)\nAdapter: ${adapter.id}\nDatabase: ${store.path}\n`,
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
        return { stderr: "No sessions found. Run `agentops run codex|claude <prompt>` or `agentops import <session.jsonl>` first.\n", exitCode: 1 };
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
        return { stderr: "No sessions found. Run `agentops run codex|claude <prompt>` or `agentops import <session.jsonl>` first.\n", exitCode: 1 };
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
        return { stderr: "No sessions found. Run `agentops run codex|claude <prompt>` or `agentops import <session.jsonl>` first.\n", exitCode: 1 };
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
        return { stderr: "No sessions found. Run `agentops run codex|claude <prompt>` or `agentops import <session.jsonl>` first.\n", exitCode: 1 };
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
        return { stderr: "No sessions found. Run `agentops run codex|claude <prompt>` or `agentops import <session.jsonl>` first.\n", exitCode: 1 };
      }
      const output =
        scope === "repo"
          ? generateRepoJsonExport(store, sessionId, getGitChanges(), config, { includeRawPayloads })
          : generateSessionJsonExport(store, sessionId, config, { includeRawPayloads });
      store.db.close();
      return outputResult(output, outPath, "JSON export");
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

function ingestArtifact(sourcePath: string, adapterId: string): string {
  const config = loadConfig("agentops.config.json");
  const input = loadAdapterInput(sourcePath);
  const adapter = resolveAdapter(input, adapterId);
  const store = openStore();
  const transcript = adapter.parse(input, config);
  const result = ingestTranscript(store, transcript, config);
  analyzeSession(store, result.sessionId, config);
  store.db.close();

  return `Ingested session ${result.sessionId} (${result.eventCount} events)\nAdapter: ${adapter.id}\nDatabase: ${store.path}\n`;
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function help(): string {
  return `AgentOps Workbench

Usage:
  agentops run codex <prompt>
  agentops run claude <prompt>
  agentops review [latest|session-id]
  agentops report latest --out report.md
  agentops capture codex <prompt> [--output .agentops/captures/codex.jsonl] [--ingest]
  agentops capture claude <prompt> [--output .agentops/captures/claude.jsonl] [--ingest]
  agentops import <session.jsonl>
  agentops ingest <session.jsonl>
  agentops adapters
  agentops adapters --input <session.jsonl>
  agentops config --check
  agentops sessions
  agentops inspect latest
  agentops import <session.jsonl> --adapter pai-export-jsonl
  agentops report latest
  agentops export latest --format json
  agentops repo-report latest
  agentops repo-report latest --format github
  agentops dashboard
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
