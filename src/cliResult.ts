export type CliResult = {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  keepAlive?: Promise<void>;
  cleanup?: () => void;
};

async function writeOutput(stream: typeof Bun.stdout, text: string): Promise<void> {
  try {
    await Bun.write(stream, text);
  } catch (error) {
    // A downstream reader such as head may finish before the command does.
    if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) throw error;
  }
}

export async function finishCli(result: CliResult): Promise<never> {
  try {
    if (result.stdout) await writeOutput(Bun.stdout, result.stdout);
    if (result.stderr) await writeOutput(Bun.stderr, result.stderr);
    if (result.keepAlive) await result.keepAlive;
  } finally {
    result.cleanup?.();
  }
  process.exit(result.exitCode);
}
