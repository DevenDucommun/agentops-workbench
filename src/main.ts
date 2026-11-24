// Process entry for the compiled `agentops` binary, `bin/agentops` (the
// package.json bin) and `bun run agentops`.
// `agentops hook` is dispatched before the CLI module graph (SQLite store,
// analyzer, dashboard, MCP) is loaded, so Claude Code hooks stay inside the
// latency budget measured in spike S1. Everything else loads the full CLI.

import { finishCli } from "./cliResult";

const argv = process.argv.slice(2);

if (argv[0] === "hook") {
  const { runHookCommand } = await import("./recorder/hook");
  process.exit(await runHookCommand(argv.slice(1)));
}

// `agentops recorder enable|disable|status` (forensic recorder, spec R1.7).
if (argv[0] === "recorder") {
  const { runRecorderCommand } = await import("./recorder/command");
  await finishCli(await runRecorderCommand(argv.slice(1)));
}

const { runCli } = await import("./cli");
await finishCli(await runCli(argv));
