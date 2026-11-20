import type { ParsedTranscript } from "../types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSession } from "../analyzer";
import { parseClaudeHooksJsonl } from "../claudeHooks";
import { type AgentOpsConfig, defaultConfig, loadConfig } from "../config";
import { getEventChain, getSessionCommits, ingestTranscript, linkSessionCommit, openStore, type SessionCommit, type Store } from "../store";

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
  const store = openStore(options.dbPath ?? process.env.AGENTOPS_DB ?? join(options.repoRoot, ".agentops", "agentops.db"));
  try {
    return storeHookTranscript(store, transcript, config, options.repoRoot);
  } finally {
    store.db.close();
  }
}

export function storeHookTranscript(store: Store, transcript: ParsedTranscript, config: AgentOpsConfig, repoRoot: string): SpoolIngestResult {
  return store.db.transaction(() => {
    // Full SHAs already known for this session (an earlier import, or a push record in this
    // transcript) resolve a short SHA the same way wherever the re-import runs.
    const isFull = (sha: string) => sha.length === 40 || sha.length === 64;
    const knownFull = new Set(getSessionCommits(store, transcript.session.id).map((commit) => commit.sha).filter(isFull));
    for (const event of transcript.events) {
      const sha = (event.gitCommit as { sha?: unknown } | undefined)?.sha;
      if (typeof sha === "string" && /^[0-9a-f]+$/i.test(sha) && isFull(sha)) knownFull.add(sha.toLowerCase());
    }
    const fromKnown = (sha: string) => {
      const matches = [...knownFull].filter((full) => full.startsWith(sha));
      return matches.length === 1 ? matches[0] : undefined;
    };
    const { sessionId, eventCount } = ingestTranscript(store, transcript, config);
    analyzeSession(store, sessionId, config);

    const rowByEventId = new Map(getEventChain(store, sessionId).filter((row) => row.eventUid).map((row) => [row.eventUid as string, row.id]));
    const commits: SessionCommit[] = [];
    for (const event of transcript.events) {
      const commit = event.gitCommit as { sha?: unknown; kind?: unknown; branch?: unknown } | undefined;
      if (typeof commit?.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(commit.sha)) continue;
      const sha = commit.sha.toLowerCase();
      const link: SessionCommit = {
        sessionId,
        sha: fromKnown(sha) ?? resolveCommit(repoRoot, sha) ?? sha,
        branch: typeof commit.branch === "string" ? commit.branch : null,
        kind: typeof commit.kind === "string" ? commit.kind : null,
        source: "tool",
        eventId: (typeof event.eventId === "string" ? rowByEventId.get(event.eventId) : undefined) ?? null
      };
      linkSessionCommit(store, link);
      commits.push(link);
    }
    return { sessionId, eventCount, commits };
  })();
}

/** Full SHA for a (possibly short) commit in the repository, or null when git cannot resolve it. */
export function resolveCommit(repoRoot: string, sha: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { stdout: "pipe", stderr: "ignore" });
    const full = proc.stdout.toString().trim();
    return proc.exitCode === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(full) ? full : null;
  } catch {
    return null;
  }
}

function repoConfig(repoRoot: string): AgentOpsConfig {
  try {
    return loadConfig(join(repoRoot, "agentops.config.json"));
  } catch {
    return defaultConfig;
  }
}
