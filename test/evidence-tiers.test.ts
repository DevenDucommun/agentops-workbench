import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { loadAdapterInput, resolveAdapter } from "../src/adapters";
import { type AgentOpsConfig, defaultConfig, validateConfigFile } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
import { type ClaimVerdict, getClaimsLedger } from "../src/ledger";
import { getCommands, ingestTranscript, openStore } from "../src/store";
import { getDashboardSession } from "../src/dashboardData";
import { generateGithubRepoComment, githubGateEvidence } from "../src/report";

// T2.7 (evidence trust model): evidence tiers, the `unverified` verdict, and a
// regression row for every case in #154. Each row checks the verdict and the
// cited run, not only the gate result.

const ROOT = join(import.meta.dir, "..");
const V = "agentops.event.v1";

type Lines = unknown[];
type Expect = { verdict: ClaimVerdict; cite?: string | null; gate: "passed" | "failed" };

function run(lines: Lines, name: string, config: AgentOpsConfig = defaultConfig) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
  const path = join(dir, name);
  writeFileSync(path, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`);
  return audit(path, dir, config);
}

function audit(path: string, dir: string, config: AgentOpsConfig) {
  const store = openStore(join(dir, "agentops.db"));
  const input = loadAdapterInput(path);
  const { sessionId } = ingestTranscript(store, resolveAdapter(input).parse(input, config), config);
  analyzeSession(store, sessionId, config);
  const claim = getClaimsLedger(store, sessionId, config).claims.find((c) => c.id === "test");
  const gate = evaluateQualityGate(store, sessionId, config, { gitChanges: [] });
  const commands = getCommands(store, sessionId);
  store.db.close();
  return { claim, gate, commands };
}

function expectCase(result: ReturnType<typeof run>, expected: Expect) {
  expect(result.claim?.verdict).toBe(expected.verdict);
  if (expected.cite !== undefined) expect(result.claim?.cited?.command ?? null).toBe(expected.cite);
  expect(result.gate.status).toBe(expected.gate);
}

// Generic agentops.event.v1
const session = (id: string) => ({ schemaVersion: V, type: "session", id });
const shell = (cmd: string, status?: string, exitCode?: number) => ({
  schemaVersion: V, type: "tool_call", toolName: "Bash", input: { cmd }, ...(status ? { status } : {}), ...(exitCode === undefined ? {} : { exitCode })
});
const final = (content: string) => ({ schemaVersion: V, type: "final_response", role: "assistant", content });

// Codex exec
const codex = (id: string, items: unknown[], text: string) => [
  { type: "thread.started", thread_id: id },
  { type: "turn.started" },
  ...items.map((item) => ({ type: "item.completed", item })),
  { type: "item.completed", item: { id: "final", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
];
const codexCmd = (id: string, command: string, status: string, exit_code: number | null) => ({ id, type: "command_execution", command, aggregated_output: "", exit_code, status });

// Claude stream
const init = (s: string) => ({ type: "system", subtype: "init", session_id: s, tools: ["Bash"], model: "claude-sonnet-5-5" });
const uses = (s: string, calls: Array<{ id: string; command: string; bg?: boolean }>) => ({
  type: "assistant", session_id: s,
  message: { role: "assistant", content: calls.map((c) => ({ type: "tool_use", id: c.id, name: "Bash", input: { command: c.command, description: "run", ...(c.bg ? { run_in_background: true } : {}) } })) }
});
const results = (s: string, rows: Array<{ id: string; isError: unknown; extra?: Record<string, unknown> }>) => ({
  type: "user", session_id: s,
  message: { role: "user", content: rows.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: "out", is_error: r.isError })) },
  ...(rows[0]?.extra ? { tool_use_result: rows[0].extra } : {})
});
const done = (s: string, text: string, denials: unknown[] = []) => [
  { type: "assistant", session_id: s, message: { role: "assistant", content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", session_id: s, result: text, permission_denials: denials }
];

// Claude hooks
const hook = (s: string, o: Record<string, unknown>) => ({ session_id: s, transcript_path: `/synthetic/${s}.jsonl`, cwd: "/workspace/demo", permission_mode: "default", ...o });
const hookBash = (s: string, id: string, command: string, response: Record<string, unknown>, bg = false) => {
  const tool_input = { command, description: "run", ...(bg ? { run_in_background: true } : {}) };
  return [hook(s, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input, tool_use_id: id }), hook(s, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input, tool_response: response, tool_use_id: id })];
};
const hookSession = (s: string, body: Lines, text: string) => [
  hook(s, { hook_event_name: "SessionStart", source: "startup" }),
  hook(s, { hook_event_name: "UserPromptSubmit", prompt: "Make the tests pass." }),
  ...body,
  hook(s, { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: text }),
  hook(s, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" })
];
const PASS = { stdout: "1 pass", stderr: "", interrupted: false };

const withSupport = (support: AgentOpsConfig["evidence"]["supportCommands"]): AgentOpsConfig => ({ ...defaultConfig, evidence: { ...defaultConfig.evidence, supportCommands: support } });

describe("#154: every case gets the expected verdict and citation", () => {
  test("1: a non-shell tool, or a generic event that only carries a command, never supports", () => {
    const mcp = { id: "i1", type: "mcp_tool_call", server: "reference", tool: "reference.shell", arguments: { command: "bun test" }, result: { content: [] }, error: null, status: "completed" };
    expect(["unsupported", "unverified"]).toContain(String(run(codex("c1", [mcp], "Tests passed."), "codex.jsonl").claim?.verdict));
    const write = run([session("g1"), { schemaVersion: V, type: "file_write", path: "notes.txt", command: "bun test", status: "completed" }, final("Tests passed.")], "g1.jsonl");
    expect(["unsupported", "unverified"]).toContain(String(write.claim?.verdict));
    expect(write.gate.status).toBe("failed");
  });

  test("2: a timed-out run is a failure", () => {
    expectCase(run(codex("c2", [codexCmd("i1", "bun test", "timed_out", null)], "Tests passed."), "codex.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
    expectCase(run([session("g2"), shell("bun test", "timed_out"), final("Tests passed.")], "g2.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
  });

  test("3: a denial on a reused Claude id never hides the earlier failed run", () => {
    const s = "stream-3";
    const lines = [
      init(s),
      uses(s, [{ id: "p", command: "bun test" }]), results(s, [{ id: "p", isError: false }]),
      uses(s, [{ id: "t", command: "bun test bad.test.ts" }]), results(s, [{ id: "t", isError: true }]),
      uses(s, [{ id: "t", command: "echo hello" }]), results(s, [{ id: "t", isError: true }]),
      ...done(s, "Tests passed.", [{ tool_name: "Bash", tool_use_id: "t", tool_input: { command: "echo hello" } }])
    ];
    const result = run(lines, "stream.jsonl");
    expectCase(result, { verdict: "contradicted", cite: "bun test bad.test.ts", gate: "failed" });
    // The denied use is still recorded once, as denied.
    expect(result.commands.filter((c) => c.status === "denied").map((c) => c.command)).toEqual(["echo hello"]);
  });

  test("3: a denial that records only part of the input still matches its use", () => {
    const s = "stream-3b";
    const lines = [init(s), uses(s, [{ id: "push", command: "git push origin main" }]), results(s, [{ id: "push", isError: true }]), ...done(s, "Done.", [{ tool_name: "Bash", tool_use_id: "push", tool_input: { command: "git push origin main" } }])];
    expect(run(lines, "stream.jsonl").commands.map((c) => [c.command, c.status])).toEqual([["git push origin main", "denied"]]);
  });

  test("4: overlapping runs are ordered by when their outcome arrived", () => {
    const s = "stream-4";
    const lines = [init(s), uses(s, [{ id: "A", command: "bun test a.test.ts" }, { id: "B", command: "bun test b.test.ts" }]), results(s, [{ id: "B", isError: false }]), results(s, [{ id: "A", isError: true }]), ...done(s, "Tests passed.")];
    expectCase(run(lines, "stream.jsonl"), { verdict: "contradicted", cite: "bun test a.test.ts", gate: "failed" });
  });

  test("5: a malformed is_error never reads as a pass", () => {
    const s = "stream-5";
    const result = run([init(s), uses(s, [{ id: "x", command: "bun test" }]), results(s, [{ id: "x", isError: "true" }]), ...done(s, "Tests passed.")], "stream.jsonl");
    expect(result.claim?.verdict).not.toBe("supported");
    expect(result.gate.status).toBe("failed");
  });

  test("6: no recorded outcome, or an echo, is never support", () => {
    expectCase(run([session("g6a"), shell("bun test"), final("Tests passed.")], "g6a.jsonl"), { verdict: "unverified", cite: "bun test", gate: "failed" });
    expectCase(run([session("g6b"), shell("echo bun test", "completed", 0), final("Tests passed.")], "g6b.jsonl"), { verdict: "unverified", cite: "echo bun test", gate: "failed" });
  });

  test("Claude interrupted results and background requests never read as success", () => {
    const s = "stream-int";
    const interrupted = { stdout: "", stderr: "", interrupted: true };
    expectCase(run([init(s), uses(s, [{ id: "x", command: "bun test" }]), results(s, [{ id: "x", isError: false, extra: interrupted }]), ...done(s, "Tests passed.")], "stream.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
    const bg = [init(s), uses(s, [{ id: "p", command: "bun test" }]), results(s, [{ id: "p", isError: false }]), uses(s, [{ id: "q", command: "bun test", bg: true }]), results(s, [{ id: "q", isError: false, extra: interrupted }]), ...done(s, "Tests passed.")];
    expectCase(run(bg, "stream.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
  });

  test("raw hooks: exitCode and exit_code spellings, and a background retry, are failures", () => {
    for (const response of [{ ...PASS, exitCode: 1 }, { ...PASS, exit_code: 1 }]) {
      expectCase(run(hookSession("h1", hookBash("h1", "t1", "bun test", response), "Tests passed."), "hooks.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
    }
    const retry = [...hookBash("h2", "t1", "bun test", PASS), ...hookBash("h2", "t2", "bun test", { ...PASS, exit_code: 1 }, true)];
    expectCase(run(hookSession("h2", retry, "Tests passed."), "hooks.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
  });

  test("7, 8: another script or a dry run is unverified, never supported", () => {
    const config = withSupport({ test: ["npm run test"] });
    expectCase(run([session("g7"), shell("npm run TEST", "completed", 0), final("Tests passed.")], "g7.jsonl", config), { verdict: "unverified", cite: "npm run TEST", gate: "failed" });
    for (const command of ["make test --just-print", "MAKEFLAGS=n make test"]) {
      expectCase(run([session("g8"), shell(command, "completed", 0), final("Tests passed.")], "g8.jsonl"), { verdict: "unverified", cite: command, gate: "failed" });
    }
  });

  test("9: a quoted failure still contradicts", () => {
    expectCase(run([session("g9"), shell("bun test", "completed", 0), shell("bun 'test' bad.test.ts", "failed", 1), final("Tests passed.")], "g9.jsonl"), { verdict: "contradicted", cite: "bun 'test' bad.test.ts", gate: "failed" });
  });

  test("rule 3 spellings: an env-wrapped failed retry contradicts; a lint run is not a test run", () => {
    const test = withSupport({ test: ["CHECK=unit node verify.cjs"] });
    expectCase(run([session("e1"), shell("CHECK=unit node verify.cjs", "completed", 0), shell("env CHECK=unit node verify.cjs", "failed", 1), final("Tests passed.")], "e1.jsonl", test), { verdict: "contradicted", cite: "env CHECK=unit node verify.cjs", gate: "failed" });
    const both = withSupport({ test: ["CHECK=unit node verify.cjs"], lint: ["node verify.cjs"] });
    const lint = run([session("e2"), shell("CHECK=unit node verify.cjs", "completed", 0), shell("node verify.cjs style.txt", "failed", 1), final("Tests passed.")], "e2.jsonl", both);
    expect([lint.claim?.verdict, lint.claim?.cited?.command]).toEqual(["supported", "CHECK=unit node verify.cjs"]);
  });

  test("10: Markdown emphasis never hides a claim", () => {
    for (const text of ["_Tests_ passed.", "Tests _passed_.", "**Tests** passed.", "__Tests__ passed.", "`bun test` passes."]) {
      expectCase(run([session("g10"), shell("bun test", "failed", 1), final(text)], "g10.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
    }
  });

  test("11: a claim past the 120-character summary is checked", () => {
    const long = `${"I updated the arithmetic implementation and documented the change for the next review. ".repeat(4)}All tests pass.`;
    expectCase(run([session("g11"), shell("bun test", "failed", 1), final(long)], "g11.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
    expectCase(run(codex("c11", [codexCmd("i1", "bun test", "failed", 1)], long), "codex.jsonl"), { verdict: "contradicted", cite: "bun test", gate: "failed" });
  });

  test("controls: an observed configured pass is supported in every adapter", () => {
    expectCase(run([session("ok"), shell("bun test", "completed", 0), final("Tests passed.")], "ok.jsonl"), { verdict: "supported", cite: "bun test", gate: "passed" });
    const s = "stream-ok";
    expectCase(run([init(s), uses(s, [{ id: "x", command: "bun test" }]), results(s, [{ id: "x", isError: false }]), ...done(s, "Tests passed.")], "stream.jsonl"), { verdict: "supported", cite: "bun test", gate: "passed" });
    expectCase(run(hookSession("hok", hookBash("hok", "t1", "bun test", PASS), "Tests passed."), "hooks.jsonl"), { verdict: "supported", cite: "bun test", gate: "passed" });
  });
});

describe("evidence tiers (rule 1) and the unverified verdict (rule 2)", () => {
  const transcript = join(ROOT, "fixtures", "forensic-terminal-transcript.txt");

  test("a pasted terminal transcript is inferred evidence: unverified, and the gate fails", () => {
    const result = audit(transcript, mkdtempSync(join(tmpdir(), "agentops-tiers-")), defaultConfig);
    expect(result.commands.every((c) => c.evidenceTier === "inferred")).toBe(true);
    expect(result.claim?.verdict).toBe("unverified");
    expect(result.claim?.cited).toMatchObject({ command: "bun test", tier: "inferred" });
    expect(result.claim?.reason).toContain("was inferred from text, not observed");
    expect(result.gate.checks.find((c) => c.id === "unverified-claims")).toMatchObject({ status: "failed", observed: 1 });
    expect(result.gate.status).toBe("failed");
  });

  test("gates.allowUnverifiedClaims passes the gate but still reports the claim as unverified", () => {
    const config = { ...defaultConfig, gates: { ...defaultConfig.gates, allowUnverifiedClaims: true, requireVerification: false } };
    const result = audit(transcript, mkdtempSync(join(tmpdir(), "agentops-tiers-")), config);
    expect(result.claim?.verdict).toBe("unverified");
    expect(result.gate.checks.find((c) => c.id === "unverified-claims")).toMatchObject({ status: "passed", observed: 1, threshold: "allowed" });
    expect(result.gate.checks.find((c) => c.id === "unsupported-final-claims")?.status).toBe("passed");
  });

  test("an inferred failure still contradicts: a failure always counts, whatever its tier", () => {
    const text = ["Terminal transcript", "", "$ bun test", "1 fail", "Process exited with code 1", "", "Final: all tests pass."].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
    writeFileSync(join(dir, "transcript.txt"), `${text}\n`);
    const result = audit(join(dir, "transcript.txt"), dir, defaultConfig);
    expect([result.claim?.verdict, result.claim?.cited?.tier]).toEqual(["contradicted", "inferred"]);
  });

  test("the config validator accepts gates.allowUnverifiedClaims and rejects a non-boolean", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
    const ok = join(dir, "ok.json");
    const bad = join(dir, "bad.json");
    writeFileSync(ok, JSON.stringify({ schemaVersion: "agentops.config.v1", gates: { allowUnverifiedClaims: true } }));
    writeFileSync(bad, JSON.stringify({ schemaVersion: "agentops.config.v1", gates: { allowUnverifiedClaims: "yes" } }));
    expect(validateConfigFile(ok).errors).toEqual([]);
    expect(validateConfigFile(ok).config.gates.allowUnverifiedClaims).toBe(true);
    expect(validateConfigFile(bad).errors.join(" ")).toContain("gates.allowUnverifiedClaims");
  });

  test("#154 interrupted audit: an analysis that fails leaves no half-imported session", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
    const path = join(dir, "agentops.db");
    openStore(path).db.close();
    // Analysis dies after the import: every risk-flag insert aborts.
    const db = new Database(path);
    db.exec("CREATE TRIGGER fail_flags BEFORE INSERT ON risk_flags BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END;");
    db.close();
    const result = Bun.spawnSync(["bun", join(ROOT, "src", "main.ts"), "audit", join(ROOT, "fixtures", "risky-session.jsonl"), "--quiet"], { cwd: dir, env: { ...process.env, AGENTOPS_DB: path } });
    expect(result.exitCode).not.toBe(0);
    const store = openStore(path);
    expect(store.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(store.db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    store.db.close();
  });

  test("a store written before the tier column never reads unknown provenance as observed", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
    const path = join(dir, "agentops.db");
    const db = new Database(path);
    const inferredPayload = JSON.stringify({ type: "command", command: "bun test", provenance: "inferred", status: "completed", exitCode: 0 });
    const plainPayload = JSON.stringify({ type: "command", command: "bun test", status: "completed", exitCode: 0 });
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_adapter TEXT, ingested_at TEXT NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, idx INTEGER NOT NULL, type TEXT NOT NULL, role TEXT, summary TEXT NOT NULL, raw_json TEXT NOT NULL);
      CREATE TABLE commands (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_id INTEGER, command TEXT NOT NULL, status TEXT, exit_code INTEGER, output TEXT);
      INSERT INTO sessions VALUES ('text', 'a.txt', 'forensic-text', '2026-01-01'), ('json', 'b.jsonl', 'agentops-jsonl', '2026-01-01'),
        ('kept', 'c.jsonl', 'agentops-jsonl', '2026-01-01'), ('hooks', 'd.jsonl', 'claude-hooks', '2026-01-01');
      INSERT INTO events (session_id, idx, type, summary, raw_json) VALUES
        ('json', 1, 'command', 'bun test', ''), ('json', 2, 'command', 'bun run lint', ''),
        ('kept', 1, 'command', 'bun test', '${inferredPayload}'), ('kept', 2, 'command', 'bun test', '${plainPayload}'),
        ('hooks', 1, 'tool_call', 'bun test', ''), ('hooks', 2, 'tool_call', 'bun test', '');
      INSERT INTO commands (session_id, event_id, command, status, exit_code) VALUES
        ('text', NULL, 'bun test', 'observed', 0),
        ('json', 1, 'bun test', 'completed', 0), ('json', 2, 'bun run lint', 'inferred', NULL),
        ('kept', 3, 'bun test', 'completed', 0), ('kept', 4, 'bun test', 'completed', 0),
        ('hooks', 5, 'bun test', 'completed', 0), ('hooks', 6, 'bun test', 'started', NULL);
    `);
    db.close();
    const store = openStore(path);
    const tiers = (id: string) => getCommands(store, id).map((c) => [c.evidenceTier, c.tierBasis ?? null]);
    expect(tiers("text")).toEqual([["inferred", "text"]]);
    // The payload is gone: the row may have been marked inferred, so it is not trusted.
    expect(tiers("json")).toEqual([["inferred", "legacy"], ["inferred", "text"]]);
    // A retained payload gives the provenance back.
    expect(tiers("kept")).toEqual([["inferred", "text"], ["observed", null]]);
    // A structured adapter never marks events inferred; a row without an outcome is inferred.
    expect(tiers("hooks")).toEqual([["observed", null], ["inferred", "no-outcome"]]);
    store.db.close();
  });
});

describe("review 6063242011: every blocking case gets the expected verdict and citation", () => {
  const text = (lines: string[], config: AgentOpsConfig = defaultConfig) => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
    writeFileSync(join(dir, "transcript.txt"), `${lines.join("\n")}\n`);
    return audit(join(dir, "transcript.txt"), dir, config);
  };
  const gates = (overrides: Partial<AgentOpsConfig["gates"]>): AgentOpsConfig => ({ ...defaultConfig, gates: { ...defaultConfig.gates, ...overrides } });
  const failedChecks = (result: { gate: { checks: Array<{ id: string; status: string }> } }) => result.gate.checks.filter((c) => c.status === "failed").map((c) => c.id);

  test("1: the two claim switches are independent", () => {
    // Allowing unsupported claims never allows unverified ones.
    const subset = run([session("s1"), shell("bun test a.test.ts", "completed", 0), final("Tests passed.")], "s1.jsonl", gates({ allowUnsupportedFinalClaims: true, allowUnverifiedClaims: false }));
    expect([subset.claim?.verdict, subset.gate.status]).toEqual(["unverified", "failed"]);
    expect(failedChecks(subset)).toEqual(["unverified-claims"]);
    // An unverified claim is not charged again as unsupported.
    const prose = text(["Ran bun test", "exit code 0", "Final: Tests passed."], gates({ allowUnverifiedClaims: true, requireVerification: false }));
    expect([prose.claim?.verdict, prose.gate.status]).toEqual(["unverified", "passed"]);
  });

  test("2: text never satisfies the verification prerequisites", () => {
    const result = text(["$ bun test", "exit code 0", "Final: Done."], gates({ requiredVerificationCommands: ["bun test"] }));
    expect(result.claim).toBeUndefined();
    // "Done." is a general success claim: pasted evidence cannot back it either.
    expect(failedChecks(result)).toEqual(["required-verification", "required-command:bun test", "unsupported-final-claims"]);
  });

  test("3: a later turn marker never erases an earlier plain-text claim; user turns never claim", () => {
    const erased = text(["$ bun test", "exit code 0", "Assistant: Tests passed.", "Final: Done."]);
    expect([erased.claim?.verdict, erased.claim?.cited?.command, erased.gate.status]).toEqual(["unverified", "bun test", "failed"]);
    const user = text(["$ bun test", "exit code 0", "User: Tests passed, right?", "Final: Done."], gates({ requireVerification: false }));
    expect(user.claim).toBeUndefined();
  });

  test("5: every denial on a reused Claude id is consumed by its own use", () => {
    const s = "stream-r5";
    const lines = [
      init(s),
      uses(s, [{ id: "p", command: "bun test" }]), results(s, [{ id: "p", isError: false }]),
      uses(s, [{ id: "t", command: "bun test first.test.ts" }]), results(s, [{ id: "t", isError: true }]),
      uses(s, [{ id: "t", command: "echo second" }]), results(s, [{ id: "t", isError: true }]),
      ...done(s, "Tests passed.", [
        { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "bun test first.test.ts" } },
        { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "echo second" } }
      ])
    ];
    const result = run(lines, "stream.jsonl");
    expectCase(result, { verdict: "supported", cite: "bun test", gate: "passed" });
    expect(result.commands.filter((c) => c.status === "denied").map((c) => c.command)).toEqual(["bun test first.test.ts", "echo second"]);
  });

  test("6: a structured call with no outcome is stored inferred, on the command and the tool call", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
    const path = join(dir, "g.jsonl");
    writeFileSync(path, `${[session("r6"), shell("bun test"), shell("bun run lint", "completed", 0), final("Done.")].map((l) => JSON.stringify(l)).join("\n")}\n`);
    const store = openStore(join(dir, "agentops.db"));
    const input = loadAdapterInput(path);
    ingestTranscript(store, resolveAdapter(input).parse(input, defaultConfig), defaultConfig);
    expect(store.db.query("SELECT command, evidence_tier AS tier FROM commands ORDER BY id").all()).toEqual([{ command: "bun test", tier: "inferred" }, { command: "bun run lint", tier: "observed" }]);
    expect(store.db.query("SELECT evidence_tier AS tier FROM tool_calls ORDER BY id").all()).toEqual([{ tier: "inferred" }, { tier: "observed" }]);
    store.db.close();
  });

  test("7: a result after the final response is not cited as an outcome; an inferred failure contradicts", () => {
    const s = "stream-r7";
    const late = run([init(s), uses(s, [{ id: "x", command: "bun test" }]), ...done(s, "Tests passed."), results(s, [{ id: "x", isError: false }])], "stream.jsonl");
    expect([late.claim?.verdict, late.claim?.cited?.command, late.claim?.cited?.outcome]).toEqual(["unverified", "bun test", "unknown"]);
    expect(late.claim?.reason).toContain("recorded its result only after the final response");
    const prose = text(["Ran bun test", "exit code 1", "Final: Tests passed."], gates({ allowUnverifiedClaims: true }));
    expect([prose.claim?.verdict, prose.claim?.cited?.command, prose.gate.status]).toEqual(["contradicted", "bun test", "failed"]);
  });
});

describe("review 6063542874: every blocking case gets the expected verdict and citation", () => {
  const gates = (overrides: Partial<AgentOpsConfig["gates"]>, base: AgentOpsConfig = defaultConfig): AgentOpsConfig => ({ ...base, gates: { ...base.gates, ...overrides } });
  const imported = (name: string, body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-tiers-"));
    const path = join(dir, name);
    writeFileSync(path, body);
    return { dir, path };
  };
  const text = (lines: string[], config: AgentOpsConfig = defaultConfig) => {
    const { dir, path } = imported("transcript.txt", `${lines.join("\n")}\n`);
    return audit(path, dir, config);
  };

  test("1: a suppressed unverified-claim flag never passes the unverified check", () => {
    const suppressed: AgentOpsConfig = { ...defaultConfig, suppressions: [{ category: "unverified-claim", reason: "Silence duplicate advisory." }] };
    const result = run([session("r1"), shell("bun test a.test.ts", "completed", 0), final("Tests passed.")], "r1.jsonl", suppressed);
    expect(result.claim?.verdict).toBe("unverified");
    expect(result.gate.checks.find((c) => c.id === "unverified-claims")).toMatchObject({ status: "failed", observed: 1 });
    expect(result.gate.status).toBe("failed");
  });

  test("2: a short unmarked claim, or one on a line with an exit code, is still a claim", () => {
    const noPrereq = gates({ requireVerification: false });
    const unmarked = text(["Ran bun test", "exit code 0", "Tests passed."], noPrereq);
    expect([unmarked.claim?.verdict, unmarked.claim?.cited?.command, unmarked.gate.status]).toEqual(["unverified", "bun test", "failed"]);
    const withExit = text(["$ bun test", "Assistant: Tests passed with exit code 0.", "Final: Done."], noPrereq);
    expect([withExit.claim?.verdict, withExit.gate.status]).toEqual(["unverified", "failed"]);
    // Control: no claim anywhere outside a user turn.
    expect(text(["Ran bun test", "exit code 0", "User: did the tests pass?", "Final: Done."], noPrereq).claim).toBeUndefined();
  });

  test("3: the dashboard applies the gate's verification rule", () => {
    const config = gates({ requiredVerificationCommands: ["bun test"] });
    const readiness = (name: string, body: string) => {
      const { dir, path } = imported(name, body);
      const store = openStore(join(dir, "agentops.db"));
      const input = loadAdapterInput(path);
      const { sessionId } = ingestTranscript(store, resolveAdapter(input).parse(input, config), config);
      analyzeSession(store, sessionId, config);
      const gate = evaluateQualityGate(store, sessionId, config, { gitChanges: [] }).status;
      const detail = getDashboardSession(store, sessionId, config);
      store.db.close();
      return [gate, detail?.decision.mergeReadiness.status, detail?.decision.mergeReadiness.verificationCount];
    };
    expect(readiness("pasted.txt", "$ bun test\nexit code 0\nFinal: Done.\n")).toEqual(["failed", "blocked", 0]);
    const structured = [session("r3"), shell("bun test", "completed", 0), final("Done.")].map((l) => JSON.stringify(l)).join("\n");
    expect(readiness("structured.jsonl", `${structured}\n`)).toEqual(["passed", "ready", 1]);
  });

  test("review 6063889161: a general success claim needs observed verification", () => {
    const optional = gates({ requireVerification: false });
    const failed = (result: { gate: { checks: Array<{ id: string; status: string }> } }) => result.gate.checks.filter((c) => c.status === "failed").map((c) => c.id);
    const pasted = text(["$ bun test", "exit code 0", "Ran bun run lint", "Final: Implemented."], optional);
    expect([pasted.gate.status, failed(pasted)]).toEqual(["failed", ["unsupported-final-claims"]]);
    // Review 6064957251: Markdown emphasis does not hide the claim, in plain text
    // or in a generic JSONL capture with only an inferred command.
    for (const spelling of ["_Implemented_.", "__Implemented__.", "*Implemented*.", "**Implemented**."]) {
      const emphasized = text(["$ bun test", "exit code 0", `Final: ${spelling}`], optional);
      expect([spelling, failed(emphasized)]).toEqual([spelling, ["unsupported-final-claims"]]);
    }
    const jsonl = run([
      { schemaVersion: V, type: "session", id: "emphasis" },
      { schemaVersion: V, type: "tool_call", toolName: "Bash", input: { cmd: "bun run lint" }, status: "inferred", provenance: "inferred" },
      { schemaVersion: V, type: "final_response", role: "assistant", content: "_Implemented_." }
    ], "emphasis.jsonl", optional);
    expect(failed(jsonl)).toEqual(["unsupported-final-claims"]);
    // Controls: an observed run backs the same claim, and a neutral final response needs nothing.
    const observed = run([session("g1"), shell("bun test", "completed", 0), final("Implemented.")], "g1.jsonl", optional);
    expect(observed.gate.status).toBe("passed");
    expect(text(["$ bun test", "exit code 0", "Final: Proceeding to the next file."], optional).gate.status).toBe("passed");
  });

  test("review 6064789225: a stored session is checked under the current rule, not its stored flags", () => {
    const optional = gates({ requireVerification: false });
    const check = (body: string, stored: (db: Database, sessionId: string) => void) => {
      const { dir, path } = imported("capture.txt", body);
      const store = openStore(join(dir, "agentops.db"));
      const input = loadAdapterInput(path);
      const { sessionId } = ingestTranscript(store, resolveAdapter(input).parse(input, optional), optional);
      analyzeSession(store, sessionId, optional);
      // Rewrite the stored analysis the way an earlier version left it: it
      // charged inferred-verification-evidence and stored no general-success flag.
      stored(store.db, sessionId);
      const gate = evaluateQualityGate(store, sessionId, optional, { gitChanges: [] });
      store.db.close();
      return gate.checks.filter((c) => c.status === "failed").map((c) => c.id);
    };
    const earlierVersion = (db: Database, sessionId: string) => {
      db.query("DELETE FROM risk_flags WHERE session_id = ? AND category = 'unsupported-success-claim'").run(sessionId);
      db.query("INSERT INTO risk_flags (session_id, event_id, severity, category, message) VALUES (?, NULL, 'medium', 'inferred-verification-evidence', 'Verification command was inferred from plain text, not observed: bun test')").run(sessionId);
    };
    const mixed = "$ bun test\nexit code 0\nRan bun run lint\nFinal: Implemented.\n";
    expect(check(mixed, earlierVersion)).toEqual(["unsupported-final-claims"]);
    expect(check(mixed.replace("Implemented.", "_Implemented_."), earlierVersion)).toEqual(["unsupported-final-claims"]);
    // Controls: a neutral final response on the same stored evidence passes, and
    // a suppression of the general-success category still applies at check time.
    expect(check("$ bun test\nexit code 0\nFinal: Proceeding to the next file.\n", earlierVersion)).toEqual([]);
    const suppressed = gates({ requireVerification: false });
    suppressed.suppressions = [{ category: "unsupported-success-claim", reason: "Accepted for this repository." }];
    const { dir, path } = imported("capture.txt", mixed);
    const store = openStore(join(dir, "agentops.db"));
    const input = loadAdapterInput(path);
    const { sessionId } = ingestTranscript(store, resolveAdapter(input).parse(input, suppressed), suppressed);
    analyzeSession(store, sessionId, suppressed);
    earlierVersion(store.db, sessionId);
    expect(evaluateQualityGate(store, sessionId, suppressed, { gitChanges: [] }).status).toBe("passed");
    store.db.close();
  });

  test("4: a citation shows the outcome as of the claim", () => {
    const s = "stream-r4";
    const render = (lines: Lines) => {
      const { dir, path } = imported("stream.jsonl", `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      const store = openStore(join(dir, "agentops.db"));
      const input = loadAdapterInput(path);
      const { sessionId } = ingestTranscript(store, resolveAdapter(input).parse(input, defaultConfig), defaultConfig);
      analyzeSession(store, sessionId, defaultConfig);
      const markdown = [githubGateEvidence(store, sessionId, defaultConfig).join("\n"), generateGithubRepoComment(store, sessionId, [], defaultConfig)];
      store.db.close();
      return markdown;
    };
    for (const markdown of render([init(s), uses(s, [{ id: "x", command: "bun test" }]), ...done(s, "Tests passed."), results(s, [{ id: "x", isError: false }])])) {
      expect(markdown).toContain("`bun test` (outcome unknown), step");
      expect(markdown).not.toContain("`bun test` (completed)");
    }
    // Control: a result before the final response keeps its recorded outcome.
    for (const markdown of render([init(s), uses(s, [{ id: "x", command: "bun test" }]), results(s, [{ id: "x", isError: false }]), ...done(s, "Tests passed.")])) {
      expect(markdown).toContain("`bun test` (completed), step");
    }
  });
});
