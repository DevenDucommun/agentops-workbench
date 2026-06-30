import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CaptureProvider = "codex" | "claude";

export type CaptureRequest = {
  provider: CaptureProvider;
  prompt: string;
  outputPath: string;
  ingest: boolean;
  dryRun: boolean;
  command: string[];
  adapterId: string;
};

export type CaptureProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CaptureResult = {
  provider: CaptureProvider;
  outputPath: string;
  adapterId: string;
  command: string[];
  stderr: string;
  dryRun: boolean;
};

export type CaptureExecutor = (command: string[]) => Promise<CaptureProcessResult>;

const captureDir = ".agentops/captures";

export function parseCaptureArgs(args: string[], now = new Date()): CaptureRequest {
  const provider = args[0];
  if (provider !== "codex" && provider !== "claude") {
    throw new Error(captureUsage());
  }

  const options = parseProviderOptions(provider, args.slice(1));
  if (!options.prompt.trim()) throw new Error(captureUsage(provider));

  const outputPath = options.outputPath ?? defaultCapturePath(provider, now);
  const adapterId = provider === "codex" ? "codex-exec-jsonl" : "claude-code-stream-json";
  const command = provider === "codex" ? codexCommand(options.prompt, options.flags) : claudeCommand(options.prompt, options.flags);

  return {
    provider,
    prompt: options.prompt,
    outputPath,
    ingest: options.ingest,
    dryRun: options.dryRun,
    command,
    adapterId
  };
}

export async function runCapture(request: CaptureRequest, executor: CaptureExecutor = spawnCaptureCommand): Promise<CaptureResult> {
  if (request.dryRun) {
    return {
      provider: request.provider,
      outputPath: request.outputPath,
      adapterId: request.adapterId,
      command: request.command,
      stderr: "",
      dryRun: true
    };
  }

  let result: CaptureProcessResult;
  try {
    result = await executor(request.command);
  } catch (error) {
    const binary = request.command[0] ?? request.provider;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start ${binary}. Is it installed and available on PATH?\n${reason}`);
  }

  const hasArtifact = result.stdout.trim().length > 0;
  if (hasArtifact) {
    mkdirSync(dirname(request.outputPath), { recursive: true });
    writeFileSync(request.outputPath, result.stdout);
  }

  if (result.exitCode !== 0) {
    const artifactNote = hasArtifact ? `\nPartial artifact: ${request.outputPath}` : "";
    const stderrNote = result.stderr.trim() ? `\nProvider stderr:\n${result.stderr.trim()}` : "";
    throw new Error(`Capture command failed with exit code ${result.exitCode}.${artifactNote}${stderrNote}`);
  }

  if (!hasArtifact) {
    const stderrNote = result.stderr.trim() ? `\nProvider stderr:\n${result.stderr.trim()}` : "";
    throw new Error(`Capture command produced an empty artifact.${stderrNote}`);
  }

  return {
    provider: request.provider,
    outputPath: request.outputPath,
    adapterId: request.adapterId,
    command: request.command,
    stderr: result.stderr,
    dryRun: false
  };
}

export function formatCaptureResult(result: CaptureResult, options: { next?: "import" | "review" | "look" | null } = {}): string {
  if (result.dryRun) {
    return [
      "Capture command (dry run)",
      `Command: ${shellQuoteCommand(result.command)}`,
      `Output: ${result.outputPath}`,
      `Adapter: ${result.adapterId}`,
      ""
    ].join("\n");
  }

  const next =
    options.next === null
      ? null
      : options.next === "review"
        ? "Next: agentops review"
        : options.next === "look"
          ? "Next: agentops look"
          : `Next: agentops import ${shellQuote(result.outputPath)}`;

  return [
    `Captured ${result.provider} session`,
    `Artifact: ${result.outputPath}`,
    `Adapter: ${result.adapterId}`,
    next,
    ""
  ].filter((line) => line !== null).join("\n");
}

export function captureUsage(provider?: CaptureProvider): string {
  const command = provider ? `agentops capture ${provider}` : "agentops capture codex|claude";
  const providerOptions =
    provider === "codex"
      ? " [--ephemeral] [--sandbox read-only|workspace-write|danger-full-access] [--model <model>] [--profile <name>]"
      : provider === "claude"
        ? " [--include-hook-events] [--no-session-persistence] [--model <model>] [--permission-mode <mode>]"
        : "";
  return `Usage: ${command} <prompt> [--output .agentops/captures/session.jsonl] [--ingest] [--dry-run]${providerOptions}`;
}

function parseProviderOptions(provider: CaptureProvider, args: string[]) {
  const promptParts: string[] = [];
  const flags: string[] = [];
  let outputPath: string | undefined;
  let ingest = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--output") {
      outputPath = readValue(args, ++index, "--output");
      continue;
    }
    if (arg === "--ingest") {
      ingest = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (provider === "codex" && arg === "--ephemeral") {
      flags.push("--ephemeral");
      continue;
    }
    if (provider === "codex" && (arg === "--sandbox" || arg === "--model" || arg === "--profile")) {
      flags.push(arg, readValue(args, ++index, arg));
      continue;
    }

    if (provider === "claude" && (arg === "--include-hook-events" || arg === "--no-session-persistence")) {
      flags.push(arg);
      continue;
    }
    if (provider === "claude" && (arg === "--model" || arg === "--permission-mode")) {
      flags.push(arg, readValue(args, ++index, arg));
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown capture option for ${provider}: ${arg}\n${captureUsage(provider)}`);
    }
    promptParts.push(arg);
  }

  return {
    prompt: promptParts.join(" "),
    outputPath,
    ingest,
    dryRun,
    flags
  };
}

function codexCommand(prompt: string, flags: string[]): string[] {
  return ["codex", "exec", "--json", ...flags, prompt];
}

function claudeCommand(prompt: string, flags: string[]): string[] {
  return ["claude", "-p", "--output-format", "stream-json", "--verbose", ...flags, prompt];
}

function defaultCapturePath(provider: CaptureProvider, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${captureDir}/${provider}-${timestamp}.jsonl`;
}

async function spawnCaptureCommand(command: string[]): Promise<CaptureProcessResult> {
  const process = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout ? new Response(process.stdout).text() : Promise.resolve(""),
    process.stderr ? new Response(process.stderr).text() : Promise.resolve(""),
    process.exited
  ]);
  return { stdout, stderr, exitCode };
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

function shellQuoteCommand(command: string[]): string {
  return command.map((part) => shellQuote(part)).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
