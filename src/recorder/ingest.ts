import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSession } from "../analyzer";
import { parseClaudeHooksJsonl } from "../claudeHooks";
import { type AgentOpsConfig, defaultConfig, loadConfig } from "../config";
import { evaluateQualityGate } from "../gate";
import { getEventChain, ingestTranscript, linkSessionCommit, openStore, type SessionCommit } from "../store";

// Session-end ingest for the forensic recorder (spec R1.6, R1.8): spool ->
// claude-hooks adapter -> store -> analyzer, then link the session to the
// commits its Bash calls made. Loaded only on SessionEnd (and by tests), never
// on the per-tool-call hook path.

export type SpoolIngestOptions = {
  /** Enrolled repository root (real path): resolves short commit SHAs and locates config and the store. */
  repoRoot: string;
  /** Store path; defaults to `<repoRoot>/.agentops/agentops.db`, which `look` reads from the repo root. */
  dbPath?: string;
  config?: AgentOpsConfig;
};

export type SpoolIngestResult = { sessionId: string; eventCount: number; commits: SessionCommit[] };

export function ingestSpoolFile(spoolFile: string, options: SpoolIngestOptions): SpoolIngestResult {
  const config = options.config ?? repoConfig(options.repoRoot);
  const transcript = parseClaudeHooksJsonl(spoolFile, readFileSync(spoolFile, "utf8"), config);
  const store = openStore(options.dbPath ?? join(options.repoRoot, ".agentops", "agentops.db"));
  try {
    const { sessionId, eventCount } = ingestTranscript(store, transcript, config);
    analyzeSession(store, sessionId, config);

    const rowByEventId = new Map(getEventChain(store, sessionId).filter((row) => row.eventUid).map((row) => [row.eventUid as string, row.id]));
    const commits: SessionCommit[] = [];
    for (const event of transcript.events) {
      const commit = event.gitCommit as { sha?: unknown; kind?: unknown; branch?: unknown } | undefined;
      if (typeof commit?.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(commit.sha)) continue;
      const link: SessionCommit = {
        sessionId,
        sha: resolveCommit(options.repoRoot, commit.sha) ?? commit.sha.toLowerCase(),
        branch: typeof commit.branch === "string" ? commit.branch : null,
        kind: typeof commit.kind === "string" ? commit.kind : null,
        source: "tool",
        eventId: (typeof event.eventId === "string" ? rowByEventId.get(event.eventId) : undefined) ?? null
      };
      linkSessionCommit(store, link);
      commits.push(link);
    }
    return { sessionId, eventCount, commits };
  } finally {
    store.db.close();
  }
}

/**
 * One-line gate verdict for the session so far (spec R1.6, T1.6): ingests the
 * spool, runs the quality gate and summarizes it. Shown at the end of a turn
 * through the Stop hook's `systemMessage`, because Claude Code discards
 * SessionEnd hook output.
 */
export function turnVerdict(spoolFile: string, options: SpoolIngestOptions): string {
  const config = options.config ?? repoConfig(options.repoRoot);
  const { sessionId } = ingestSpoolFile(spoolFile, { ...options, config });
  const store = openStore(options.dbPath ?? join(options.repoRoot, ".agentops", "agentops.db"));
  try {
    const gate = evaluateQualityGate(store, sessionId, config);
    const failed = gate.checks.filter((check) => check.status === "failed");
    const detail =
      failed.length === 0 ? "all quality gates passed" : failed.map((check) => `${check.label}: ${check.message.replace(/\.$/, "")}`).join("; ");
    const line = `agentops: ${gate.status === "passed" ? "passed" : "needs review"}: ${detail} (agentops look ${sessionId})`;
    return line.replace(/\s+/g, " ").slice(0, 300);
  } finally {
    store.db.close();
  }
}

/** Full SHA for a (possibly short) commit in the repository, or null when git cannot resolve it. */
export function resolveCommit(repoRoot: string, sha: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { stdout: "pipe", stderr: "ignore" });
  const full = proc.stdout.toString().trim();
  return proc.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(full) ? full : null;
}

function repoConfig(repoRoot: string): AgentOpsConfig {
  try {
    return loadConfig(join(repoRoot, "agentops.config.json"));
  } catch {
    return defaultConfig;
  }
}
