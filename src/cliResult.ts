export type CliResult = {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  keepAlive?: Promise<void>;
  cleanup?: () => void;
};

export async function finishCli(result: CliResult): Promise<never> {
  try {
    if (result.stdout) await Bun.write(Bun.stdout, result.stdout);
    if (result.stderr) await Bun.write(Bun.stderr, result.stderr);
    if (result.keepAlive) await result.keepAlive;
  } finally {
    result.cleanup?.();
  }
  process.exit(result.exitCode);
}
