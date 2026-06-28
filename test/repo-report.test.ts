import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { parseJsonlTranscript } from "../src/parser";
import { generateGithubRepoComment, generateMarkdownRepoReport } from "../src/report";
import { ingestTranscript, openStore } from "../src/store";

test("generates repo report with observed and unobserved git changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-repo-report-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript("fixtures/sample-session.jsonl", readFileSync("fixtures/sample-session.jsonl", "utf8"));
  ingestTranscript(store, transcript, defaultConfig);
  analyzeSession(store, "sample-session", defaultConfig);

  const report = generateMarkdownRepoReport(
    store,
    "sample-session",
    [
      { path: "src/server.ts", status: "M", additions: 4, deletions: 0 },
      { path: "docs/new-note.md", status: "??", additions: null, deletions: null }
    ],
    defaultConfig
  );

  expect(report).toContain("# AgentOps Repo Report");
  expect(report).toContain("Git Files Observed In Session | 1");
  expect(report).toContain("Git Files Not Observed In Session | 1");
  expect(report).toContain("`src/server.ts`");
  expect(report).toContain("`docs/new-note.md`");
  expect(report).toContain("`test/server.test.ts` - edit");

  store.db.close();
});

test("generates GitHub-ready repo comment without posting", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-repo-report-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript("fixtures/risky-session.jsonl", readFileSync("fixtures/risky-session.jsonl", "utf8"));
  ingestTranscript(store, transcript, defaultConfig);
  analyzeSession(store, "risky-session", defaultConfig);

  const report = generateGithubRepoComment(
    store,
    "risky-session",
    [{ path: "deploy/production.yaml", status: "M", additions: 600, deletions: 25 }],
    defaultConfig
  );

  expect(report).toContain("## AgentOps Workbench Report");
  expect(report).toContain("**Status:** High-risk findings present");
  expect(report).toContain("Generated locally by AgentOps Workbench");
  expect(report).toContain("<details><summary>Commands run</summary>");

  store.db.close();
});
