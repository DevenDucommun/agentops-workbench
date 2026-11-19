// smoke:recorder — builds the release-style binary and checks `agentops hook`
// against the spike S1 budget (AC4): p95 per hook call at or under
// AGENTOPS_HOOK_P95_BUDGET_MS (default 50 ms), spawned through `sh -c` the way
// Claude Code runs command hooks, with a ~20 KB PostToolUse payload. Also
// checks that every call exits 0 with no output, the spool chain is valid, and
// an unenrolled repository records nothing (AC2).
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkChain } from "../src/eventChain";
import { enrollRepository } from "../src/recorder/enrollment";
import { readSpool, spoolPath } from "../src/recorder/spool";

const budgetMs = Number(process.env.AGENTOPS_HOOK_P95_BUDGET_MS ?? 50);
const runs = Number(process.env.AGENTOPS_HOOK_SMOKE_RUNS ?? 200);
const warmup = 10;

const root = mkdtempSync(join(tmpdir(), "agentops-smoke-recorder-"));
const binary = join(root, "agentops");
const build = Bun.spawnSync(["bun", "build", "--compile", "./src/main.ts", "--outfile", binary], { stdout: "ignore", stderr: "pipe" });
if (build.exitCode !== 0) fail(`binary build failed: ${build.stderr.toString()}`);

const stateDir = join(root, "state");
const enrolled = join(root, "enrolled-repo");
const other = join(root, "other-repo");
for (const dir of [enrolled, other]) {
  mkdirSync(dir, { recursive: true });
  if (Bun.spawnSync(["git", "init", "-q", dir]).exitCode !== 0) fail(`git init failed for ${dir}`);
}
enrollRepository(enrolled, stateDir);
writeFileSync(join(enrolled, "agentops.config.json"), JSON.stringify({ schemaVersion: "agentops.config.v1", privacy: { storeRawPayload: false } }));

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGENTOPS_STATE_DIR: stateDir };
const sessionId = "0a1b2c3d-5307-4000-8000-000000005307";
const stdout = "the quick brown fox ran tests ok 123\n".repeat(540);
const payload = (cwd: string, sid: string, i: number) =>
  JSON.stringify({
    session_id: sid,
    transcript_path: "/synthetic/t.jsonl",
    cwd,
    prompt_id: "5e1f0a00-5307-4000-8000-0000000053a7",
    permission_mode: "default",
    effort: { level: "medium" },
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "bun test", description: `call ${i}` },
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    tool_use_id: `toolu_01Smoke${String(i).padStart(5, "0")}`.padEnd(30, "0"),
    duration_ms: 1200
  });

async function hook(input: string): Promise<{ ms: number; code: number; out: string; err: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn(["sh", "-c", `"${binary}" hook PostToolUse`], { env, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ms: performance.now() - t0, code, out, err };
}

const samples: number[] = [];
for (let i = 0; i < warmup + runs; i++) {
  const r = await hook(payload(enrolled, sessionId, i));
  if (r.code !== 0 || r.out || r.err) fail(`hook call ${i} exited ${r.code} with output: ${(r.out + r.err).slice(0, 200)}`);
  if (i >= warmup) samples.push(r.ms);
}

// AC2 and R1.4: unenrolled repo and malformed input record nothing and stay silent.
for (const input of [payload(other, "0a1b2c3d-5307-4000-8000-0000000000ff", 0), "not json", "", "[1,2]"]) {
  const r = await hook(input);
  if (r.code !== 0 || r.out || r.err) fail(`edge input exited ${r.code} with output: ${(r.out + r.err).slice(0, 200)}`);
}

const { records, invalidLines } = readSpool(spoolPath(join(stateDir, "spool"), sessionId) as string);
const chain = checkChain(records);
const spoolFiles = readdirSync(join(stateDir, "spool")).filter((f) => f.endsWith(".jsonl"));

const sorted = [...samples].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const p50 = pct(0.5);
const p95 = pct(0.95);
console.log(`smoke:recorder  runs=${runs} (+${warmup} warm-up)  p50=${p50.toFixed(1)} ms  p95=${p95.toFixed(1)} ms  max=${sorted.at(-1)?.toFixed(1)} ms  budget p95<=${budgetMs} ms`);
console.log(`spool: ${records.length} records, chain ${chain.status}, invalid lines ${invalidLines.length}, spool files ${spoolFiles.length}`);

if (records.length !== warmup + runs) fail(`expected ${warmup + runs} records, found ${records.length}`);
if (chain.status !== "valid" || invalidLines.length > 0) fail(`spool chain ${chain.status}, invalid lines ${invalidLines.join(",")}`);
if (spoolFiles.length !== 1) fail(`unenrolled or malformed input created spool files: ${spoolFiles.join(", ")}`);
if (p95 > budgetMs) fail(`p95 ${p95.toFixed(1)} ms is over the ${budgetMs} ms budget`);
console.log("smoke:recorder passed");

function fail(message: string): never {
  console.error(`smoke:recorder FAILED: ${message}`);
  process.exit(1);
}
