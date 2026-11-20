// Process entry for the compiled `agentops` binary, `bin/agentops` (the
// package.json bin) and `bun run agentops`.
// `agentops hook` is dispatched before the CLI module graph (SQLite store,
// analyzer, dashboard, MCP) is loaded, so Claude Code hooks stay inside the
// latency budget measured in spike S1. Everything else loads the full CLI.

export {};

const argv = process.argv.slice(2);

if (argv[0] === "hook") {
  const { runHookCommand } = await import("./recorder/hook");
  process.exit(await runHookCommand(argv.slice(1)));
}

// `agentops recorder enable|disable|status` (forensic recorder, spec R1.7).
if (argv[0] === "recorder") {
  const { runRecorderCommand } = await import("./recorder/command");
  const out = await runRecorderCommand(argv.slice(1));
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exitCode);
}

const { runCli } = await import("./cli");
const result = await runCli(argv);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.keepAlive) await result.keepAlive;
result.cleanup?.();
process.exit(result.exitCode);
