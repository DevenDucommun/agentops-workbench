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
    'test "$3" = "$METHOD" && test "$4" = "$ENDPOINT" && test "$5" = "-F" && test "$6" = "body=@$REPORT" && test "$7" = "--jq" && test "$8" = ".id" || exit 2',
    'cat "$REPORT" > "$POSTED"',
    'echo "$COMMENT_ID"'
  ].join("\n"), { mode: 0o755 });
  for (const [existing, method, endpoint, id, action] of [["", "POST", "issues/7/comments", "34", "created"], ["21", "PATCH", "issues/comments/21", "21", "updated"]]) {
    const posted = join(dir, method);
    const stepOutput = join(dir, `${method}-output`);
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", post.run], {
      cwd: dir, env: { PATH: dir + ":" + env.PATH, REPORT: report, GITHUB_REPOSITORY: "org/repo", PR_NUMBER: "7", GITHUB_OUTPUT: stepOutput,
        EXISTING: existing, METHOD: method, ENDPOINT: "repos/org/repo/" + endpoint, POSTED: posted, COMMENT_ID: id }
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(posted, "utf8")).toBe(markdown);
    // The step reports which comment it wrote and whether it created it.
    expect(readFileSync(stepOutput, "utf8")).toBe(`id=${id}\naction=${action}\n`);
  }
});

test("comment-key gives each key its own sticky comment", () => {
  const root = join(import.meta.dir, "..");
  const dir = mkdtempSync(join(tmpdir(), "agentops-action-key-"));
  // The gate report's first line is the marker; an invalid key stops before any write.
  const report = (key: string) => {
    const proc = Bun.spawnSync(["bash", script], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", AGENTOPS_BIN: "false", AGENTOPS_ARTIFACTS: "", AGENTOPS_REPORT_DIR: dir, AGENTOPS_COMMENT_KEY: key, GITHUB_OUTPUT: join(dir, `out-${key}`) },
      stdout: "pipe", stderr: "pipe"
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    const path = /Report: (.*)$/m.exec(out)?.[1];
    return { exitCode: proc.exitCode, out, path, firstLine: path ? readFileSync(path, "utf8").split("\n")[0] : null };
  };
  expect(report("").firstLine).toBe("<!-- agentops-gate -->");
  expect(report("a").firstLine).toBe("<!-- agentops-gate:a -->");
  for (const bad of ["has space", "x -->", "a".repeat(65)]) {
    const result = report(bad);
    expect([bad, result.exitCode, result.path]).toEqual([bad, 1, undefined]);
    expect(result.out).toContain("comment-key must be");
  }

  // The comment step's own selection filter, run by real jq over existing comments:
  // the default comment and keys `a` and `ab` never match each other.
  const action = Bun.YAML.parse(readFileSync(join(root, "action.yml"), "utf8")) as { runs: { steps: Array<{ name: string; run: string }> } };
  const post = action.runs.steps.find(step => step.name === "Post sticky PR comment")!;
  const comments = join(dir, "comments.json");
  writeFileSync(comments, JSON.stringify([
    { id: 1, body: "<!-- agentops-gate -->\ndefault" },
    { id: 2, body: "<!-- agentops-gate:a -->\nkey a" },
    { id: 3, body: "<!-- agentops-gate:ab -->\nkey ab" }
  ]));
  writeFileSync(join(dir, "gh"), [
    "#!/bin/sh",
    'if [ "$2" != "-X" ]; then jq -r "$5" "$COMMENTS"; exit 0; fi',
    'echo "$3 $4" > "$CALLED"',
    'echo 99'
  ].join("\n"), { mode: 0o755 });
  for (const [key, expected] of [["", "PATCH repos/org/repo/issues/comments/1"], ["a", "PATCH repos/org/repo/issues/comments/2"], ["ab", "PATCH repos/org/repo/issues/comments/3"], ["abc", "POST repos/org/repo/issues/7/comments"]]) {
    const { path } = report(key);
    const called = join(dir, `called-${key}`);
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", post.run], {
      cwd: dir, env: { PATH: dir + ":" + (process.env.PATH ?? ""), REPORT: path!, GITHUB_REPOSITORY: "org/repo", PR_NUMBER: "7", GITHUB_OUTPUT: join(dir, `step-${key}`), COMMENTS: comments, CALLED: called }
    });
    expect([key, result.exitCode, readFileSync(called, "utf8").trim()]).toEqual([key, 0, expected]);
  }
});
