import { adapters, detectAdapters, loadAdapterInput, resolveAdapter } from "./adapters";
import { analyzeSession } from "./analyzer";
import { formatConfigValidationResult, loadConfig, validateConfigFile } from "./config";
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

    if (command === "ingest") {
      const sourcePath = args[0];
      if (!sourcePath) return { stderr: "Usage: agentops ingest <session.jsonl>\n", exitCode: 1 };

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

    if (command === "inspect") {
      const sessionArg = readOption(args, "--session") ?? "latest";
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: "No sessions found. Run `agentops ingest <session.jsonl>` first.\n", exitCode: 1 };
      }
      const output = generateSessionInspection(store, sessionId, config);
      store.db.close();
      return { stdout: output, exitCode: 0 };
    }

    if (command === "report") {
      const sessionArg = readOption(args, "--session") ?? "latest";
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: "No sessions found. Run `agentops ingest <session.jsonl>` first.\n", exitCode: 1 };
      }
      const report = generateMarkdownReport(store, sessionId, config);
      store.db.close();
      return { stdout: report, exitCode: 0 };
    }

    if (command === "repo-report") {
      const sessionArg = readOption(args, "--session") ?? "latest";
      const configPath = readOption(args, "--config") ?? "agentops.config.json";
      const format = readOption(args, "--format") ?? "markdown";
      const config = loadConfig(configPath);
      const store = openStore();
      const sessionId = getSessionId(store, sessionArg);
      if (!sessionId) {
        store.db.close();
        return { stderr: "No sessions found. Run `agentops ingest <session.jsonl>` first.\n", exitCode: 1 };
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
      return { stdout: report, exitCode: 0 };
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

    return { stderr: `Unknown command: ${command}\n\n${help()}`, exitCode: 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stderr: `${message}\n`, exitCode: 1 };
  }
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

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function help(): string {
  return `AgentOps Workbench

Usage:
  agentops ingest <session.jsonl>
  agentops adapters
  agentops adapters --input <session.jsonl>
  agentops config --check
  agentops sessions
  agentops inspect --session latest
  agentops ingest <session.jsonl> --adapter pai-export-jsonl
  agentops report --session latest
  agentops repo-report --session latest
  agentops repo-report --session latest --format github
  agentops dashboard
  agentops scan-publication

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
