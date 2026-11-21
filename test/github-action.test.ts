import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const script = join(import.meta.dir, "..", "scripts", "github-action.sh");

function run(artifacts: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-action-"));
  // The gate binary is never reached in these cases; `false` would fail loudly if it were.
  const proc = Bun.spawnSync(["bash", script], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", AGENTOPS_BIN: "false", AGENTOPS_ARTIFACTS: artifacts, AGENTOPS_REPORT_DIR: dir },
    stdout: "pipe",
    stderr: "pipe"
  });
  return { dir, exitCode: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

test("a glob that matches nothing fails the gate", () => {
  const result = run("captures/*.jsonl");
  expect(result.exitCode).toBe(1);
  expect(result.out).toContain("captures/*.jsonl (artifact not found)");
  expect(result.out).not.toContain("passed");
});

test("an input that is only whitespace fails instead of passing with zero artifacts", () => {
  const result = run("  \n ");
  expect(result.exitCode).toBe(1);
  expect(result.out).toContain("resolved to no paths");
});

test("an unmatched glob next to a real file is still reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-action-real-"));
  writeFileSync(join(dir, "x.txt"), "not a transcript\n");
  const result = run(`${join(dir, "*.txt")} ${join(dir, "missing", "*.jsonl")}`);
  expect(result.exitCode).toBe(1);
  expect(result.out).toContain("(artifact not found)");
});

test("a whitespace-only input still writes the failed status and report when enforcement is deferred", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-action-deferred-"));
  const output = join(dir, "github-output");
  const summary = join(dir, "step-summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const proc = Bun.spawnSync(["bash", script], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", AGENTOPS_BIN: "false", AGENTOPS_ARTIFACTS: "  \n  ", AGENTOPS_REPORT_DIR: dir,
      AGENTOPS_FAIL_ON_GATE: "false", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    stdout: "pipe",
    stderr: "pipe"
  });
  expect(proc.exitCode).toBe(0);
  const outputs = readFileSync(output, "utf8");
  expect(outputs).toContain("status=failed");
  expect(outputs).toContain("failed=1");
  expect(readFileSync(summary, "utf8")).toContain("resolved to no paths");
});
