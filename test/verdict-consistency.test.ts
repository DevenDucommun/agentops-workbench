import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const cli = resolve("bin/agentops");
const action = resolve("scripts/github-action.sh");

function claudeArtifact(id: string, edit: boolean, attempts: Array<[string, boolean | null]>) {
  const calls = [["Edit", { file_path: "reviewed.ts" }], ...attempts.map(([command]) => ["Bash", { command }])];
  const outcomes = [edit, ...attempts.map(([, outcome]) => outcome)];
  const records = [
    { type: "system", subtype: "init", session_id: id },
    { type: "assistant", message: { role: "assistant", content: calls.map(([name, input], i) => ({ type: "tool_use", id: String(i), name, input })) } },
    { type: "user", message: { role: "user", content: outcomes.flatMap((ok, i) => ok === null ? [] : [{ type: "tool_result", tool_use_id: String(i), is_error: !ok }]).reverse() } },
    { type: "result", subtype: "success", result: "Lint passed." }
  ];
  return records.map((record) => JSON.stringify(record)).join("\n");
}

test("CLI, dashboard and Action identify the same session and apply its verification policy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentops-verdict-"));
  const env = { ...process.env, AGENTOPS_DB: join(cwd, "store.db") };
  const run = (...args: string[]) => Bun.spawnSync([cli, ...args], { cwd, env });
  const config = join(cwd, "agentops.config.json");
  writeFileSync(config, JSON.stringify({ gates: { requiredVerificationCommands: ["lint"] } }));
  const cases: { id: string; passed: boolean; edited: boolean; artifact?: string; attempts: Array<[string, boolean | null]> }[] = [
    { id: "build.17", passed: false, edited: false, attempts: [["bun run lint", false]] },
    { id: "missing-lint", passed: false, edited: true, attempts: [["bun test", true]] },
    { id: "partial", passed: false, edited: false, attempts: [["bun run lint", null]] },
    { id: "last-failed", passed: false, edited: true, attempts: [["bun test", true], ["bun test", false], ["bun run lint", true]] },
    { id: "generic-no-outcome", passed: false, edited: false, attempts: [], artifact: [
      { type: "session", id: "generic-no-outcome" },
      { type: "tool_call", command: "bun run lint" },
      { type: "final_response", content: "Lint passed." }
    ].map((record) => JSON.stringify(record)).join("\n") },
    { id: "full-suite-retry", passed: true, edited: true, attempts: [], artifact: [
      { type: "session", id: "full-suite-retry" },
      { type: "tool_call", command: "bun test test/new.test.ts", exitCode: 1 },
      { type: "file_edit", path: "reviewed.ts", operation: "edit" },
      { type: "tool_call", command: "bun test", exitCode: 0 },
      { type: "tool_call", command: "bun run lint", exitCode: 0 },
      { type: "final_response", content: "All tests pass." }
    ].map((record) => JSON.stringify(record)).join("\n") },
    { id: "recovered", passed: true, edited: true, attempts: [["bun run lint", false], ["bun run lint", true]] }
  ];

  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = String(listener.port);
  listener.stop(true);
  const dashboard = Bun.spawn([cli, "open", "--port", port], { cwd, env, stdout: "pipe", stderr: "pipe" });
  try {
    const startup = await dashboard.stdout.getReader().read();
    expect(new TextDecoder().decode(startup.value)).toContain("dashboard listening");
    for (const { id, edited, attempts, artifact: records } of cases) {
      const artifact = join(cwd, id + ".jsonl");
      writeFileSync(artifact, records ?? claudeArtifact(id, edited, attempts));
      expect(run("audit", artifact, "--quiet").exitCode).toBe(0);
    }
    for (const { id, passed, edited } of cases) {
      const result = run("check", id, "--format", "json");
      const status = passed ? "passed" : "failed";
      expect(result.exitCode).toBe(passed ? 0 : 1);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ sessionId: id, status });
      const detail = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}`)).json();
      expect(detail.session.id).toBe(id);
      expect(detail.decision.mergeReadiness.gateStatus).toBe(status);
      expect(detail.decision.mergeReadiness.status === "ready").toBe(passed);
      const lint = detail.decision.evidence.find((row: { id: string }) => row.id === "lint");
      if (id === "full-suite-retry") expect(detail.decision.evidence.find((row: { id: string }) => row.id === "test")?.status).toBe("verified");
      if (id === "partial" || id === "generic-no-outcome") expect(lint?.status).toBe("missing-evidence");
      if (id === "build.17") expect(lint?.status).toBe("contradicted");
      if (id === "recovered") expect(lint?.status).toBe("verified");
      expect(detail.files.map((file: { path: string }) => file.path)).toEqual(edited ? ["reviewed.ts"] : []);
      const summary = join(cwd, id + ".md");
      const job = Bun.spawnSync(["bash", action], { cwd, env: {
        ...env, AGENTOPS_BIN: cli, AGENTOPS_ARTIFACTS: id + ".jsonl", AGENTOPS_CONFIG: config,
        AGENTOPS_FAIL_ON_GATE: "true", AGENTOPS_REPORT_DIR: cwd, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: summary
      } });
      expect(job.exitCode).toBe(result.exitCode);
      const markdown = readFileSync(summary, "utf8");
      expect(markdown).toContain(`Session: \`${id}\``);
      expect(markdown).toContain(passed ? "PASS PASSED" : "FAIL FAILED");
    }
    expect(run("check", "missing.17").exitCode).toBe(1);
  } finally {
    dashboard.kill();
    await dashboard.exited;
    rmSync(cwd, { recursive: true, force: true });
  }
});
