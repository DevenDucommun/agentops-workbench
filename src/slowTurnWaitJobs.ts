import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
type WaitJob = { kind: string; origin: { sequence: number; evidence: string } };
export type WaitJobs = Map<string, WaitJob>;
const kinds = new Set(["preflight", "review", "merge", "test", "build", "CI"]);
const record = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isCellWait = (tool: Row) => tool.name === "wait" || tool.executionPhase === "cell-wait";
const linkedJobs = new Map([["preflight", "preflight"], ["test-suite", "test"], ["ci-wait", "CI"]]);
export function linkedJobKind(launch: Row | undefined) {
  if (launch?.executionPhase === "initial" && typeof launch.operation === "string") {
    return linkedJobs.get(launch.operation);
  }
}

// An annotation records an independently traced relationship. The digest binds
// array positions to one export. Never infer process ownership from proximity.
export function parseWaitJobs(raw: string, input: unknown, file: unknown): WaitJobs {
  if (!record(file) || file.schemaVersion !== 1 || !Array.isArray(file.jobs) ||
      file.exportSha256 !== createHash("sha256").update(raw).digest("hex")) {
    throw Error("Invalid wait-job evidence or timing export digest mismatch");
  }
  const jobs: WaitJobs = new Map();
  const launchKinds = new Map<string, string>();
  if (!record(input) || !Array.isArray(input.sessions)) throw Error("Invalid timing export");
  for (const job of file.jobs) {
    if (!record(job) || typeof job.turn !== "string" || typeof job.kind !== "string" ||
        !kinds.has(job.kind) || !Array.isArray(job.waitSequences) || !job.waitSequences.length) {
      throw Error("Invalid wait-job record");
    }
    const match = /^\/sessions\/(0|[1-9]\d*)\/interactions\/(0|[1-9]\d*)$/.exec(job.turn);
    const turn = match && input.sessions[Number(match[1])]?.interactions?.[Number(match[2])];
    if (!Array.isArray(turn?.tools)) throw Error("Unknown wait-job turn");
    const tools: unknown[] = turn.tools;
    function resolve(sequence: unknown) {
      if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
        throw Error("Invalid wait-job sequence");
      }
      const index = tools.findIndex(t => record(t) && t.sequence === sequence);
      if (index < 0 || tools.some((t, i) => i > index && record(t) && t.sequence === sequence)) {
        throw Error("Missing or ambiguous wait-job sequence");
      }
      return { index, tool: tools[index] as Row, sequence };
    }
    const launch = resolve(job.launchSequence);
    if (isCellWait(launch.tool)) throw Error("A wait cannot be its own job launcher");
    const origin = { evidence: job.turn + "/tools/" + launch.index, sequence: launch.sequence };
    const knownKind = launchKinds.get(origin.evidence) ?? linkedJobKind(launch.tool);
    if (knownKind !== undefined && knownKind !== job.kind) {
      throw Error(`Conflicting job kinds for launch ${origin.evidence}: ${knownKind} and ${job.kind}`);
    }
    launchKinds.set(origin.evidence, job.kind);
    for (const sequence of job.waitSequences) {
      const wait = resolve(sequence);
      const key = job.turn + "/tools/" + wait.index;
      const execPoll = wait.tool.name === "exec" && wait.tool.executionPhase === "continuation";
      if ((!isCellWait(wait.tool) && !execPoll) || wait.index <= launch.index || wait.sequence <= launch.sequence || jobs.has(key)) {
        throw Error("Invalid or duplicate wait-job link");
      }
      jobs.set(key, { kind: job.kind, origin });
    }
  }
  return jobs;
}
