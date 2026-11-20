import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseForensicTextTranscript } from "../src/forensicText";
import { getGitChanges } from "../src/git";
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
