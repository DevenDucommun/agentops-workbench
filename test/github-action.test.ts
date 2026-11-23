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

test("Action summary and sticky comment cite the same failed run and the later successful retry", () => {
  const root = join(import.meta.dir, "..");
  const dir = mkdtempSync(join(tmpdir(), "agentops-action-evidence-"));
  const output = join(dir, "outputs");
  const summary = join(dir, "summary");
  const env = {
    PATH: process.env.PATH ?? "", AGENTOPS_BIN: join(root, "bin", "agentops"),
    AGENTOPS_ARTIFACTS: ["fail-then-claim", "fail-then-pass-then-claim"].map(name => join(root, "fixtures", "ledger", name + ".jsonl")).join("\n"),
    AGENTOPS_REPORT_DIR: dir, AGENTOPS_FAIL_ON_GATE: "false", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary
  };
  const gate = Bun.spawnSync(["bash", script], { cwd: dir, env });
  expect(gate.exitCode).toBe(0);
  const outputs = readFileSync(output, "utf8");
  expect(outputs).toContain("status=failed\nfailed=1\n");
  const report = /^report=(.*)$/m.exec(outputs)![1];
  const markdown = readFileSync(summary, "utf8");
  expect(markdown).toBe(readFileSync(report, "utf8"));
  expect(markdown).toContain("| test | Contradicted | `bun test` (exit 1), step 3 |");
  expect(markdown).toContain("| test | Supported | `bun test` (exit 0), step 4 (evt-0002-test-pass) |");
  expect(markdown).toContain("### Other recorded verification failures\n\n- `bun test` (exit 1), step 2");

  // Run the composite's actual comment step with a local GitHub CLI stand-in.
  const action = Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as { runs: { steps: Array<{ name: string; run: string }> } };
  const post = action.runs.steps.find(step => step.name === "Post sticky PR comment")!;
  writeFileSync(join(dir, "gh"), [
    "#!/bin/sh",
    'if [ "$2" != "-X" ]; then echo "$EXISTING"; exit 0; fi',
    'test "$3" = "$METHOD" && test "$4" = "$ENDPOINT" && test "$5" = "-F" && test "$6" = "body=@$REPORT" || exit 2',
    'cat "$REPORT" > "$POSTED"'
  ].join("\n"), { mode: 0o755 });
  for (const [existing, method, endpoint] of [["", "POST", "issues/7/comments"], ["21", "PATCH", "issues/comments/21"]]) {
    const posted = join(dir, method);
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", post.run], {
      cwd: dir, env: { PATH: dir + ":" + env.PATH, REPORT: report, GITHUB_REPOSITORY: "org/repo", PR_NUMBER: "7",
        EXISTING: existing, METHOD: method, ENDPOINT: "repos/org/repo/" + endpoint, POSTED: posted }
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(posted, "utf8")).toBe(markdown);
  }
});
