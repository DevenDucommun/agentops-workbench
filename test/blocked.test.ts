import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { resolveAdapter } from "../src/adapters";
import { type AgentOpsConfig, defaultConfig, validateConfigFile } from "../src/config";
import { evaluateQualityGate } from "../src/gate";
import { getRiskFlags, ingestTranscript, openStore } from "../src/store";

const ROOT = join(import.meta.dir, "..");

function audit(fixture: string, config: AgentOpsConfig = defaultConfig) {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-blocked-")), "agentops.db"));
  const path = isAbsolute(fixture) ? fixture : join(ROOT, fixture);
  const content = readFileSync(path, "utf8");
  const transcript = resolveAdapter({ sourcePath: path, content }).parse({ sourcePath: path, content }, config);
  const { sessionId } = ingestTranscript(store, transcript, config);
  analyzeSession(store, sessionId, config);
  const flags = getRiskFlags(store, sessionId);
  const gate = evaluateQualityGate(store, sessionId, config, { gitChanges: [] });
  store.db.close();
  const check = (id: string) => gate.checks.find((c) => c.id === id);
  return { flags, gate, check };
}

const withConfig = (patch: { risk?: Partial<AgentOpsConfig["risk"]>; gates?: Partial<AgentOpsConfig["gates"]> }): AgentOpsConfig => ({
  ...defaultConfig,
  risk: { ...defaultConfig.risk, ...patch.risk },
  gates: { ...defaultConfig.gates, ...patch.gates }
});

describe("blocked-attempt policy (spec R2.4)", () => {
  test("a declined destructive command raises a low blocked-attempt flag, not a high destructive-command", () => {
    const { flags, gate, check } = audit("fixtures/blocked/declined-destructive.jsonl");
    expect(flags.map((f) => [f.severity, f.category, f.message])).toEqual([["low", "blocked-attempt", "Destructive command was declined and did not run: rm -rf ./out"]]);
    expect(check("max-high-risks")?.observed).toBe(0);
    expect(check("max-blocked-attempts")).toMatchObject({ status: "passed", observed: 1, threshold: "<= 2" });
    expect(gate.status).toBe("passed");
  });

  test("repeated blocked attempts fail the gate above gates.maxBlockedAttempts", () => {
    expect(audit("fixtures/blocked/repeated-attempts.jsonl").check("max-blocked-attempts")).toMatchObject({ status: "failed", observed: 3 });
    expect(audit("fixtures/blocked/repeated-attempts.jsonl", withConfig({ gates: { maxBlockedAttempts: 3 } })).check("max-blocked-attempts")?.status).toBe("passed");
  });

  test("a denied command matching both rules is one blocked attempt", () => {
    const stream = [
      JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "blocked-double", agent: "synthetic-agent" }),
      ...[1, 2].map((n) => JSON.stringify({ schemaVersion: "agentops.event.v1", type: "tool_call", toolName: "Bash", input: { cmd: `chmod -R 777 ./out${n}` }, status: "denied" })),
      JSON.stringify({ schemaVersion: "agentops.event.v1", type: "final_response", role: "assistant", content: "Left the permissions alone." })
    ].join("\n");
    const path = join(mkdtempSync(join(tmpdir(), "agentops-blocked-")), "double.jsonl");
    writeFileSync(path, stream);
    const { flags, check } = audit(path);
    expect(flags.map((f) => [f.category, f.message])).toEqual([
      ["blocked-attempt", "Destructive, permission-changing command was denied and did not run: chmod -R 777 ./out1"],
      ["blocked-attempt", "Destructive, permission-changing command was denied and did not run: chmod -R 777 ./out2"]
    ]);
    expect(check("max-blocked-attempts")).toMatchObject({ status: "passed", observed: 2 });
  });

  test("risk.treatBlockedAsExecuted restores the v3.2 behavior", () => {
    const { flags, check } = audit("fixtures/blocked/declined-destructive.jsonl", withConfig({ risk: { treatBlockedAsExecuted: true } }));
    expect(flags.map((f) => [f.severity, f.category])).toEqual([["high", "destructive-command"]]);
    expect(check("max-high-risks")?.status).toBe("failed");
    expect(check("max-blocked-attempts")?.observed).toBe(0);
  });

  test("the declined rm -rf in the Codex fixture no longer fails max-high-risks", () => {
    const { flags, check } = audit("fixtures/codex-exec-current-session.jsonl");
    expect(flags.map((f) => f.category)).toContain("blocked-attempt");
    expect(flags.map((f) => f.category)).not.toContain("destructive-command");
    expect(check("max-high-risks")?.status).toBe("passed");
  });

  test("executed destructive commands are still high severity", () => {
    const { flags } = audit("fixtures/risky-session.jsonl");
    expect(flags.filter((f) => f.category === "destructive-command").map((f) => f.severity)).toEqual(["high"]);
  });
});

describe("config", () => {
  test("new keys are validated", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentops-blocked-config-")), "agentops.config.json");
    writeFileSync(path, JSON.stringify({ risk: { treatBlockedAsExecuted: "yes" }, gates: { maxBlockedAttempts: -1 } }));
    const { errors } = validateConfigFile(path);
    expect(errors).toContain("risk.treatBlockedAsExecuted must be a boolean.");
    expect(errors).toContain("gates.maxBlockedAttempts must be a non-negative integer.");
  });
});

describe("review 6010175616: start rows and stores analyzed without the rule", () => {
  const codexDecline = (withStart: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "agentops-blocked-"));
    const item = (status: string) => ({ id: "c1", type: "command_execution", command: "rm -rf ./out", aggregated_output: "", exit_code: null, status });
    const lines = [
      { type: "thread.started", thread_id: "codex-decline" },
      ...(withStart ? [{ type: "item.started", item: item("in_progress") }] : []),
      { type: "item.completed", item: item("declined") },
      { type: "turn.completed", usage: {} }
    ];
    const path = join(dir, "codex.jsonl");
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
    return audit(path);
  };

  test("a Codex start record followed by a decline is one blocked attempt, as without the start", () => {
    const withStart = codexDecline(true);
    const withoutStart = codexDecline(false);
    expect(withStart.flags.map((f) => f.category)).toEqual(withoutStart.flags.map((f) => f.category));
    expect(withStart.check("max-high-risks")?.observed).toBe(0);
    expect(withStart.check("max-blocked-attempts")?.observed).toBe(1);
  });

  test("the gate counts blocked attempts from commands even when the stored flags predate the rule", () => {
    const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-blocked-")), "agentops.db"));
    const path = join(ROOT, "fixtures/blocked/repeated-attempts.jsonl");
    const content = readFileSync(path, "utf8");
    const transcript = resolveAdapter({ sourcePath: path, content }).parse({ sourcePath: path, content }, defaultConfig);
    const { sessionId } = ingestTranscript(store, transcript, defaultConfig);
    // No analysis: as if the store was analyzed by an older release, or analysis was interrupted.
    const gate = evaluateQualityGate(store, sessionId, defaultConfig, { gitChanges: [] });
    const reaudited = (analyzeSession(store, sessionId, defaultConfig), evaluateQualityGate(store, sessionId, defaultConfig, { gitChanges: [] }));
    store.db.close();
    const blocked = (result: typeof gate) => result.checks.find((c) => c.id === "max-blocked-attempts");
    expect(blocked(gate)).toMatchObject({ status: blocked(reaudited)?.status, observed: blocked(reaudited)?.observed });
    expect(blocked(gate)?.observed).toBeGreaterThan(0);
  });
});
