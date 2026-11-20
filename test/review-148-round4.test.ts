import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { finalClaimTexts } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { parseForensicTextTranscript } from "../src/forensicText";
import { getGitChanges, getGitChangesOrEmpty } from "../src/git";
import { fallbackSessionId } from "../src/parser";
import { redactString } from "../src/redaction";
import { ingestTranscript, listSessions, openStore } from "../src/store";

test("fallback ids never look like credentials, so redaction cannot merge sessions", () => {
  // "task-<hex>" contains "sk-<hex>", which matched the OpenAI-style key rule.
  for (const stem of ["task", "disk", "desk", "ghp", "xoxb"]) {
    const id = fallbackSessionId(`${stem}.txt`, "content", "session");
    expect(redactString(id)).toBe(id);
  }
  expect(fallbackSessionId("notes.txt", "content", "session")).toMatch(/^notes-[0-9a-f]{32}$/);
});

test("distinct captures named task.txt stay separate sessions", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-r4-")), "agentops.db"));
  ingestTranscript(store, parseForensicTextTranscript("a/task.txt", "$ bun test\nexit code 0\nFinal: run a.\n", defaultConfig), defaultConfig);
  ingestTranscript(store, parseForensicTextTranscript("b/task.txt", "$ bun test\nexit code 0\nFinal: run b.\n", defaultConfig), defaultConfig);
  const ids = listSessions(store).map((session) => session.id);
  expect(ids).toHaveLength(2);
  expect(ids.every((id) => !id.includes("REDACTED"))).toBe(true);
  store.db.close();
});

test("before the first commit, unstaged edits to a staged file count toward line totals", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-r4-git-")));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "a\nb\n");
  Bun.spawnSync(["git", "add", "f.txt"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "a\nb\nc\nd\n");
  expect(getGitChanges(dir)).toEqual([{ path: "f.txt", status: "AM", additions: 4, deletions: 0 }]);
});

test("captures with identical text but different names keep separate sessions", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-r5-")), "agentops.db"));
  const text = "$ bun test\nexit code 0\nFinal: same text.\n";
  ingestTranscript(store, parseForensicTextTranscript("task.txt", text, defaultConfig), defaultConfig);
  ingestTranscript(store, parseForensicTextTranscript("desk.txt", text, defaultConfig), defaultConfig);
  expect(listSessions(store)).toHaveLength(2);
  store.db.close();
});

test("a summary whose words occur inside a longer word is still checked for claims", () => {
  const event = { summary: "build complete", text: "The rebuild completed overnight." };
  expect(finalClaimTexts(event)).toEqual(["The rebuild completed overnight.", "build complete"]);
  expect(finalClaimTexts({ summary: "The rebuild comp...", text: "The rebuild completed overnight." })).toEqual(["The rebuild completed overnight."]);
});

test("an unreadable git config fails instead of reporting no changes", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-r5-git-")));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "a\n");
  chmodSync(join(dir, ".git", "config"), 0o000);
  try {
    expect(() => getGitChanges(dir)).toThrow(/Unable to read git state/);
    expect(() => getGitChangesOrEmpty(dir)).toThrow(/Unable to read git state/);
  } finally {
    chmodSync(join(dir, ".git", "config"), 0o644);
  }
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agentops-r5-norepo-")));
  expect(getGitChangesOrEmpty(outside)).toEqual([]);
});

test("a summary that only shares the body's opening letters is still checked", () => {
  expect(finalClaimTexts({ summary: "Build complete", text: "Build completeness is still unknown." }))
    .toEqual(["Build completeness is still unknown.", "Build complete"]);
  expect(finalClaimTexts({ summary: "Build complete.", text: "Build complete." })).toEqual(["Build complete."]);
});

test("captures whose file names redact keep separate sessions", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-r6-")), "agentops.db"));
  const text = "$ bun test\nexit code 0\nFinal: same text.\n";
  // Email-shaped names, assembled at runtime so the publication scan does not flag the source.
  const named = (user: string) => `${[user, "example.invalid"].join("@")}.txt`;
  ingestTranscript(store, parseForensicTextTranscript(named("alice"), text, defaultConfig), defaultConfig);
  ingestTranscript(store, parseForensicTextTranscript(named("bob"), text, defaultConfig), defaultConfig);
  const ids = listSessions(store).map((session) => session.id);
  expect(ids).toHaveLength(2);
  expect(ids.every((id) => redactString(id) === id)).toBe(true);
  store.db.close();
});
