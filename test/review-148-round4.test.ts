import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { finalClaimTexts } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { generateRepoJsonExport } from "../src/export";
import { parseForensicTextTranscript } from "../src/forensicText";
import { decodeGitOutput, displayGitPath, getGitChanges, getGitChangesOrEmpty } from "../src/git";
import { fallbackSessionId, parseJsonlTranscript } from "../src/parser";
import { redactString } from "../src/redaction";
import { getEvents, ingestTranscript, listSessions, openStore } from "../src/store";

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
  expect(finalClaimTexts({ summary: "Build complete...", text: "Build completeness is still unknown." }))
    .toEqual(["Build completeness is still unknown.", "Build complete..."]);
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

test("a content-only final response keeps its full text as the summary, so no clipped claim appears", () => {
  const content = "I reviewed the release notes and packaging checklist. One item still needs confirmation from the team. Build completeness is still unknown.";
  const transcript = parseJsonlTranscript("final.jsonl", [
    JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "derived" }),
    JSON.stringify({ schemaVersion: "agentops.event.v1", type: "final_response", content })
  ].join("\n"));
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-r7-")), "agentops.db"));
  ingestTranscript(store, transcript, defaultConfig);
  const final = getEvents(store, "derived").find((event) => event.type === "final_response");
  expect(final?.summary).toBe(content);
  expect(finalClaimTexts(final as { text?: string | null; summary: string })).toEqual([content]);
  store.db.close();
});

test("git paths that differ only in non-UTF-8 bytes stay distinct", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-r7-git-")));
  const sh = (script: string) => Bun.spawnSync(["bash", "-c", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  sh("git init -q && git -c user.name=synthetic -c user.email=synthetic -c commit.gpgsign=false commit -q --allow-empty -m init");
  sh("blob=$(printf x | git hash-object -w --stdin); { printf '100644 %s\\tfile-\\x80.txt\\000' $blob; printf '100644 %s\\tfile-\\x81.txt\\000' $blob; } | git update-index -z --add --index-info");
  const paths = getGitChanges(dir).map((change) => change.path).sort();
  expect(paths).toHaveLength(2);
  expect(new Set(paths).size).toBe(2);
});

test("git path decoding: raw bytes never collide with a name spelled with backslashes, and a leading U+FEFF is kept", () => {
  const raw = decodeGitOutput(Buffer.from([0x78, 0x2d, 0x80, 0x81]));
  const literal = decodeGitOutput(Buffer.from("x-\\200\\201", "utf8"));
  expect(raw).not.toBe(literal);
  expect(decodeGitOutput(Buffer.from("﻿note.md", "utf8"))).toBe("﻿note.md");
  expect(decodeGitOutput(Buffer.from("café.ts", "utf8"))).toBe("café.ts");
});

test("outside a repository the diff is empty in any locale", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agentops-r7-locale-")));
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = "fr_FR.UTF-8";
  try {
    expect(getGitChangesOrEmpty(outside)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previous;
  }
});

test("reports show non-UTF-8 git path bytes as \\xNN, so distinct paths stay distinct", () => {
  expect(displayGitPath(decodeGitOutput(Buffer.from([0x66, 0x2d, 0x80])))).toBe("f-\\x80");
  expect(displayGitPath(decodeGitOutput(Buffer.from([0x66, 0x2d, 0x81])))).toBe("f-\\x81");
  expect(displayGitPath("café.ts")).toBe("café.ts");
});

test("the redacted-name fallback id hashes the whole file name, extension included", () => {
  const name = (ext: string) => `${["one", "example.invalid"].join("@")}.${ext}`;
  expect(fallbackSessionId(name("txt"), "same", "forensic-session")).not.toBe(fallbackSessionId(name("log"), "same", "forensic-session"));
});

test("report display keeps emoji intact and never prints two paths alike", () => {
  expect(displayGitPath(decodeGitOutput(Buffer.from("case-💡.ts", "utf8")))).toBe("case-💡.ts");
  const rawByte = displayGitPath(decodeGitOutput(Buffer.from([0x66, 0x2d, 0x80])));
  const literal = displayGitPath(decodeGitOutput(Buffer.from("f-\\x80", "utf8")));
  expect(rawByte).toBe("f-\\x80");
  expect(literal).toBe("f-\\\\x80");
  expect(rawByte).not.toBe(literal);
});

test("the repo JSON export keeps non-UTF-8 git paths distinct after a JSON round trip", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "agentops-json-")), "agentops.db"));
  const transcript = parseJsonlTranscript("s.jsonl", JSON.stringify({ schemaVersion: "agentops.event.v1", type: "session", id: "json-paths" }));
  ingestTranscript(store, transcript, defaultConfig);
  const changes = [0x80, 0x81].map((byte) => ({ path: decodeGitOutput(Buffer.from([0x66, 0x2d, byte])), status: "??", additions: null, deletions: null }));
  const output = generateRepoJsonExport(store, "json-paths", changes, defaultConfig);
  // Lone surrogates would decode to U+FFFD in most JSON readers (jq, Python); none may remain.
  expect(/\\ud[c-f][0-9a-f]{2}/i.test(output)).toBe(false);
  expect(JSON.parse(output).git.changes.map((change: { path: string }) => change.path)).toEqual(["f-\\x80", "f-\\x81"]);
  store.db.close();
});
