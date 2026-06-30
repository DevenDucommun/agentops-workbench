import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runCli } from "../src/cli";

const originalDb = process.env.AGENTOPS_DB;
const originalCwd = process.cwd();

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-cli-test-"));
  process.env.AGENTOPS_DB = join(dir, "agentops.db");
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalDb === undefined) {
    delete process.env.AGENTOPS_DB;
  } else {
    process.env.AGENTOPS_DB = originalDb;
  }
});

test("initializes local setup and applies safe doctor fixes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-init-test-"));
  process.chdir(dir);
  process.env.AGENTOPS_DB = join(dir, ".agentops", "agentops.db");

  const init = await runCli(["init"]);
  expect(init.exitCode).toBe(0);
  expect(init.stdout).toContain("# AgentOps Init");
  expect(init.stdout).toContain("Setup:");
  expect(init.stdout).toContain("CREATED .gitignore: added .agentops/");
  expect(init.stdout).toContain("CREATED Config: agentops.config.json");
  expect(init.stdout).toContain("Recommended next command:");
  expect(init.stdout).toContain("agentops demo");
  expect(existsSync(".agentops")).toBe(true);
  expect(readFileSync(".gitignore", "utf8")).toContain(".agentops/");
  expect(JSON.parse(readFileSync("agentops.config.json", "utf8"))).toMatchObject({ schemaVersion: "agentops.config.v1" });

  const secondInit = await runCli(["init"]);
  expect(secondInit.exitCode).toBe(0);
  expect(secondInit.stdout).toContain("OK .gitignore: .agentops/ already ignored");
  expect(secondInit.stdout).toContain("OK Config: agentops.config.json already exists");

  writeFileSync(".gitignore", "node_modules\n");
  const doctorFix = await runCli(["doctor", "--fix"]);
  expect(doctorFix.exitCode).toBe(0);
  expect(doctorFix.stdout).toContain("# AgentOps Doctor");
  expect(doctorFix.stdout).toContain("Safe fixes:");
  expect(doctorFix.stdout).toContain("UPDATED .gitignore: added .agentops/");
  expect(readFileSync(".gitignore", "utf8")).toContain(".agentops/");
});

test("lists adapters and detection diagnostics", async () => {
  const list = await runCli(["adapters"]);
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toContain("agentops-jsonl");
  expect(list.stdout).toContain("claude-code-stream-json");
  expect(list.stdout).toContain("codex-exec-jsonl");
  expect(list.stdout).toContain("forensic-text");

  const detected = await runCli(["adapters", "--input", "fixtures/codex-session.jsonl"]);
  expect(detected.exitCode).toBe(0);
  expect(detected.stdout).toContain("AgentOps JSONL (100%)");
  expect(detected.stdout).toContain("source=codex");

  const forensic = await runCli(["adapters", "--input", "fixtures/forensic-terminal-transcript.txt"]);
  expect(forensic.exitCode).toBe(0);
  expect(forensic.stdout).toContain("Forensic Plain Text");
  expect(forensic.stdout).toContain("2 observed commands");

  const weakForensic = await runCli(["adapters", "--input", "fixtures/forensic-final-only.txt"]);
  expect(weakForensic.exitCode).toBe(0);
  expect(weakForensic.stdout).toContain("provider marker");
});

test("prints capture dry-run commands without invoking providers", async () => {
  const codex = await runCli([
    "capture",
    "codex",
    "review current diff",
    "--output",
    ".agentops/captures/codex.jsonl",
    "--ephemeral",
    "--dry-run"
  ]);
  expect(codex.exitCode).toBe(0);
  expect(codex.stdout).toContain("Capture command (dry run)");
  expect(codex.stdout).toContain("codex exec --json --ephemeral 'review current diff'");
  expect(codex.stdout).toContain("Adapter: codex-exec-jsonl");

  const claude = await runCli([
    "capture",
    "claude",
    "review current diff",
    "--output",
    ".agentops/captures/claude.jsonl",
    "--include-hook-events",
    "--dry-run"
  ]);
  expect(claude.exitCode).toBe(0);
  expect(claude.stdout).toContain("claude -p --output-format stream-json --verbose --include-hook-events 'review current diff'");
  expect(claude.stdout).toContain("Adapter: claude-code-stream-json");
});

test("prints run dry-run commands as the simple capture entrypoint", async () => {
  const result = await runCli(["run", "codex", "review current diff", "--ephemeral", "--dry-run"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Capture command (dry run)");
  expect(result.stdout).toContain("codex exec --json --ephemeral 'review current diff'");
  expect(result.stdout).toContain("Adapter: codex-exec-jsonl");
});

test("validates config files", async () => {
  const defaults = await runCli(["config", "--check"]);
  expect(defaults.exitCode).toBe(0);
  expect(defaults.stdout).toContain("AgentOps config OK");
  expect(defaults.stdout).toContain("Using built-in defaults");

  const dir = mkdtempSync(join(tmpdir(), "agentops-config-test-"));
  const invalidPath = join(dir, "agentops.config.json");
  writeFileSync(
    invalidPath,
    JSON.stringify({
      schemaVersion: "agentops.config.v1",
      privacy: {
        storeRawPayload: true,
        redactBeforeStore: false,
        hashRawPayload: false
      },
      gates: {
        requireVerification: "yes",
        maxHighSeverityRisks: -1,
        requiredVerificationCommands: ["test", 123]
      },
      suppressions: [{ category: "large-churn" }]
    })
  );

  const invalid = await runCli(["config", "--check", "--config", invalidPath]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr).toContain("privacy.storeRawPayload requires privacy.redactBeforeStore");
  expect(invalid.stderr).toContain("privacy.storeRawPayload requires privacy.hashRawPayload");
  expect(invalid.stderr).toContain("gates.requireVerification must be a boolean");
  expect(invalid.stderr).toContain("gates.maxHighSeverityRisks must be a non-negative integer");
  expect(invalid.stderr).toContain("gates.requiredVerificationCommands must be an array of non-empty strings");
  expect(invalid.stderr).toContain("suppressions[0].reason is required");
});

test("ingests then lists and inspects sessions", async () => {
  const ingest = await runCli(["import", "fixtures/claude-code-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);
  expect(ingest.stdout).toContain("Adapter: agentops-jsonl");

  const sessions = await runCli(["sessions"]);
  expect(sessions.exitCode).toBe(0);
  expect(sessions.stdout).toContain("claude-code-sample");
  expect(sessions.stdout).toContain("agentops-jsonl");

  const inspect = await runCli(["inspect", "--session", "latest"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("# AgentOps Session Inspection");
  expect(inspect.stdout).toContain("Claude Code");
  expect(inspect.stdout).toContain("Verification Commands");
  expect(inspect.stdout).toContain("Synthetic Claude Code export completed");

  const positionalInspect = await runCli(["inspect", "latest"]);
  expect(positionalInspect.exitCode).toBe(0);
  expect(positionalInspect.stdout).toContain("# AgentOps Session Inspection");

  const review = await runCli(["review"]);
  expect(review.exitCode).toBe(0);
  expect(review.stdout).toContain("# AgentOps Session Inspection");

  const reportPath = join(tmpdir(), `agentops-report-${Date.now()}.md`);
  const report = await runCli(["report", "latest", "--out", reportPath]);
  expect(report.exitCode).toBe(0);
  expect(report.stdout).toContain(`Wrote report: ${reportPath}`);
  expect(existsSync(reportPath)).toBe(true);
  expect(readFileSync(reportPath, "utf8")).toContain("# AgentOps Session Report");

  const exported = await runCli(["export", "--session", "latest", "--format", "json"]);
  expect(exported.exitCode).toBe(0);
  const payload = JSON.parse(exported.stdout ?? "") as { schemaVersion: string; kind: string; events: Array<{ rawJson?: string }> };
  expect(payload.schemaVersion).toBe("agentops.export.v1");
  expect(payload.kind).toBe("session");
  expect(payload.events.every((event) => event.rawJson === undefined)).toBe(true);

  const openInference = await runCli(["export", "--session", "latest", "--format", "openinference-json"]);
  expect(openInference.exitCode).toBe(0);
  expect(openInference.stdout).toContain("agentops.openinference.v1");
  expect(openInference.stdout).toContain("openinference.span.kind");
});

test("guides first-run setup with doctor and demo commands", async () => {
  const empty = await runCli(["sessions"]);
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).toContain("agentops demo");
  expect(empty.stdout).toContain("agentops audit <session.jsonl|transcript.txt>");

  const doctor = await runCli(["doctor"]);
  expect(doctor.exitCode).toBe(0);
  expect(doctor.stdout).toContain("# AgentOps Doctor");
  expect(doctor.stdout).toContain("Bun runtime");
  expect(doctor.stdout).toContain(".agentops ignore");
  expect(doctor.stdout).toContain("Recommended next command");

  const demo = await runCli(["demo"]);
  expect(demo.exitCode).toBe(0);
  expect(demo.stdout).toContain("# AgentOps Demo");
  expect(demo.stdout).toContain("sample-session (ready");
  expect(demo.stdout).toContain("risky-session (blocked");
  expect(demo.stdout).toContain("agentops open");
  expect(demo.stdout).toContain("Dashboard URL: http://127.0.0.1:4927");

  const sessions = await runCli(["sessions"]);
  expect(sessions.exitCode).toBe(0);
  expect(sessions.stdout).toContain("sample-session");
  expect(sessions.stdout).toContain("risky-session");
});

test("audits artifacts and creates PR-ready output with short commands", async () => {
  const audit = await runCli(["audit", "fixtures/sample-session.jsonl"]);
  expect(audit.exitCode).toBe(0);
  expect(audit.stdout).toContain("# AgentOps Audit");
  expect(audit.stdout).toContain("# AgentOps Session Inspection");
  expect(audit.stdout).toContain("# AgentOps Quality Gate");
  expect(audit.stdout).not.toContain("Database:");

  const risky = await runCli(["audit", "fixtures/risky-session.jsonl"]);
  expect(risky.exitCode).toBe(1);
  expect(risky.stdout).toContain("Status: FAILED");

  const pr = await runCli(["pr", "sample-session"]);
  expect(pr.exitCode).toBe(0);
  expect(pr.stdout).toContain("AgentOps Workbench Report");
  expect(pr.stdout).toContain("AgentOps Quality Gate");
});

test("supports simplified product workflow commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-simple-workflow-test-"));
  process.chdir(dir);
  process.env.AGENTOPS_DB = join(dir, ".agentops", "agentops.db");

  const emptyStatus = await runCli([]);
  expect(emptyStatus.exitCode).toBe(0);
  expect(emptyStatus.stdout).toContain("# AgentOps Status");
  expect(emptyStatus.stdout).toContain("No sessions found");

  const imported = await runCli(["audit", join(originalCwd, "fixtures/sample-session.jsonl")]);
  expect(imported.exitCode).toBe(0);

  const status = await runCli(["status"]);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain("Latest session: sample-session");
  expect(status.stdout).toContain("agentops look");

  const look = await runCli(["look"]);
  expect(look.exitCode).toBe(0);
  expect(look.stdout).toContain("# AgentOps Session Inspection");

  const check = await runCli(["check"]);
  expect(check.exitCode).toBe(0);
  expect(check.stdout).toContain("# AgentOps Quality Gate");
  expect(check.stdout).toContain("Status: PASSED");

  const save = await runCli(["save"]);
  expect(save.exitCode).toBe(0);
  expect(save.stdout).toContain("Saved AgentOps bundle");
  for (const file of ["agentops-report.md", "agentops-pr-comment.md", "agentops-gate.json", "agentops-session.json"]) {
    expect(existsSync(file)).toBe(true);
  }

  const trace = await runCli(["save", "trace"]);
  expect(trace.exitCode).toBe(0);
  expect(trace.stdout).toContain("agentops-openinference.json");
  expect(readFileSync("agentops-openinference.json", "utf8")).toContain("agentops.openinference.v1");

  const customPr = await runCli(["save", "pr", "custom-pr.md"]);
  expect(customPr.exitCode).toBe(0);
  expect(customPr.stdout).toContain("custom-pr.md");
  expect(existsSync("custom-pr.md")).toBe(true);

  const optionPr = await runCli(["save", "pr", "--out", "option-pr.md"]);
  expect(optionPr.exitCode).toBe(0);
  expect(optionPr.stdout).toContain("option-pr.md");
  expect(existsSync("option-pr.md")).toBe(true);
});

test("gives clearer guidance for common command mistakes", async () => {
  const outputAsCommand = await runCli(["report.md", "latest"]);
  expect(outputAsCommand.exitCode).toBe(1);
  expect(outputAsCommand.stderr).toContain("It looks like that is an output filename");
  expect(outputAsCommand.stderr).toContain("agentops report latest --out report.md");

  const dbAsInput = await runCli(["ingest", ".agentops/agentops.db"]);
  expect(dbAsInput.exitCode).toBe(1);
  expect(dbAsInput.stderr).toContain("expects a session artifact or transcript, not the SQLite database");
  expect(dbAsInput.stderr).toContain("agentops review");

  const dbAsImport = await runCli(["import", ".agentops/agentops.db"]);
  expect(dbAsImport.exitCode).toBe(1);
  expect(dbAsImport.stderr).toContain("agentops import expects a session artifact or transcript");
});

test("inspect and sessions include usage metadata when available", async () => {
  const ingest = await runCli(["ingest", "fixtures/usage-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);

  const sessions = await runCli(["sessions"]);
  expect(sessions.exitCode).toBe(0);
  expect(sessions.stdout).toContain("usage-session");
  expect(sessions.stdout).toContain("1,540");

  const inspect = await runCli(["inspect", "--session", "usage-session"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("Input Tokens");
  expect(inspect.stdout).toContain("Output Tokens");
  expect(inspect.stdout).toContain("Total Tokens");
  expect(inspect.stdout).toContain("0.0142 USD");
});

test("ingests native Codex exec JSONL without explicit adapter selection", async () => {
  const ingest = await runCli(["ingest", "fixtures/codex-exec-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);
  expect(ingest.stdout).toContain("Adapter: codex-exec-jsonl");

  const inspect = await runCli(["inspect", "--session", "codex-exec-sample"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("Codex");
  expect(inspect.stdout).toContain("bun run typecheck");
  expect(inspect.stdout).toContain("Total Tokens");
  expect(inspect.stdout).toContain("1,150");
});

test("ingests native Claude Code stream JSONL without explicit adapter selection", async () => {
  const ingest = await runCli(["ingest", "fixtures/claude-code-stream-session.jsonl"]);
  expect(ingest.exitCode).toBe(0);
  expect(ingest.stdout).toContain("Adapter: claude-code-stream-json");

  const inspect = await runCli(["inspect", "--session", "claude-stream-sample"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("Claude Code");
  expect(inspect.stdout).toContain("bun test");
  expect(inspect.stdout).toContain("Total Tokens");
  expect(inspect.stdout).toContain("1,180");
  expect(inspect.stdout).toContain("0.0123 USD");
});

test("imports forensic plain-text transcripts without explicit adapter selection", async () => {
  const ingest = await runCli(["import", "fixtures/forensic-terminal-transcript.txt"]);
  expect(ingest.exitCode).toBe(0);
  expect(ingest.stdout).toContain("Adapter: forensic-text");
  expect(ingest.stdout).toContain("Evidence quality: forensic text");
  expect(ingest.stdout).toContain("Observed commands: 2");
  expect(ingest.stdout).toContain("Inferred files: 2");
  expect(ingest.stdout).toContain("Prefer agentops run or provider JSONL");
  expect(ingest.stdout).toContain("Next: agentops look forensic-terminal-transcript");

  const inspect = await runCli(["review", "forensic-terminal-transcript"]);
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain("Plain-text forensic import");
  expect(inspect.stdout).toContain("bun test");
  expect(inspect.stdout).toContain("observed, exit 0");

  const weak = await runCli(["import", "fixtures/forensic-final-only.txt"]);
  expect(weak.exitCode).toBe(0);
  expect(weak.stdout).toContain("Adapter: forensic-text");
  expect(weak.stdout).toContain("Evidence quality: weak forensic text");
  expect(weak.stdout).toContain("Observed commands: 0");
  expect(weak.stdout).toContain("transcript has no observable shell commands");

  const report = await runCli(["review", "forensic-final-only", "--format", "markdown"]);
  expect(report.exitCode).toBe(0);
  expect(report.stdout).toContain("weak-forensic-transcript");
  expect(report.stdout).toContain("No test, lint, typecheck, or verification command recorded.");
});

test("runs quality gates with CI-friendly exit codes and formats", async () => {
  const sample = await runCli(["import", "fixtures/sample-session.jsonl"]);
  expect(sample.exitCode).toBe(0);

  const passed = await runCli(["gate", "sample-session"]);
  expect(passed.exitCode).toBe(0);
  expect(passed.stdout).toContain("Status: PASSED");
  expect(passed.stdout).toContain("Verification evidence");

  const json = await runCli(["gate", "sample-session", "--format", "json"]);
  expect(json.exitCode).toBe(0);
  const payload = JSON.parse(json.stdout ?? "") as { schemaVersion: string; status: string; checks: Array<{ id: string }> };
  expect(payload.schemaVersion).toBe("agentops.gate.v1");
  expect(payload.status).toBe("passed");
  expect(payload.checks).toContainEqual(expect.objectContaining({ id: "required-verification" }));

  const risky = await runCli(["import", "fixtures/risky-session.jsonl"]);
  expect(risky.exitCode).toBe(0);

  const failed = await runCli(["gate", "risky-session", "--format", "github"]);
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).toContain("AgentOps Quality Gate");
  expect(failed.stdout).toContain("FAIL FAILED");
  expect(failed.stdout).toContain("High-severity risks");
});
