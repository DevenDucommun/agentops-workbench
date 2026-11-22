import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { parseForensicTextTranscript } from "../src/forensicText";
import { getGitChanges } from "../src/git";
import { fallbackSessionId, parseJsonlTranscript } from "../src/parser";
import { getEvents, getRiskFlags, ingestTranscript, listSessions, openStore } from "../src/store";

const tempStore = () => openStore(join(mkdtempSync(join(tmpdir(), "agentops-r2-")), "agentops.db"));

test("transcripts whose hashes share an 8-hex prefix keep separate sessions", () => {
  // Both digests start d6b6ccc3; the old 32-bit id merged them into one session.
  const a = "$ bun test\nexit code 0\nFinal: synthetic run 45047.\n";
  const b = "$ bun test\nexit code 0\nFinal: synthetic run 111747.\n";
  expect(fallbackSessionId("terminal.txt", a, "x")).not.toBe(fallbackSessionId("terminal.txt", b, "x"));
  const store = tempStore();
  ingestTranscript(store, parseForensicTextTranscript("one/terminal.txt", a, defaultConfig), defaultConfig);
  ingestTranscript(store, parseForensicTextTranscript("two/terminal.txt", b, defaultConfig), defaultConfig);
  expect(listSessions(store)).toHaveLength(2);
  store.db.close();
});

function plainTextFlags(transcript: string): string[] {
  const store = tempStore();
  const parsed = parseForensicTextTranscript("terminal.txt", transcript, defaultConfig);
  ingestTranscript(store, parsed, defaultConfig);
  analyzeSession(store, parsed.session.id, defaultConfig);
  const categories = getRiskFlags(store, parsed.session.id).map((flag) => flag.category);
  store.db.close();
  return categories;
}

test("plain text: prose mentioning an exit code does not end the final response", () => {
  const flags = plainTextFlags(["$ bun test", "exit code 0", "Final: The suite finished.", "The test process returned exit code 0.", "Lint is clean."].join("\n"));
  expect(flags).toContain("missing-lint-evidence");
});

test("plain text: a later user turn is not part of the assistant's final response", () => {
  const flags = plainTextFlags(["$ bun test", "exit code 0", "Final: Tests passed.", "User: Lint is clean."].join("\n"));
  expect(flags).not.toContain("missing-lint-evidence");
});

test("a producer's display summary is kept while claims are checked against the full content", () => {
  const content = "## Done\n\n- Tests passed.\n- Lint is clean.";
  const events = [
    { schemaVersion: "agentops.event.v1", type: "session", id: "display" },
    { schemaVersion: "agentops.event.v1", type: "tool_call", input: { cmd: "bun test" }, status: "completed", exitCode: 0 },
    { schemaVersion: "agentops.event.v1", type: "final_response", summary: "Work complete.", content }
  ];
  const store = tempStore();
  ingestTranscript(store, parseJsonlTranscript("display.jsonl", events.map((e) => JSON.stringify(e)).join("\n")), defaultConfig);
  analyzeSession(store, "display", defaultConfig);
  const final = getEvents(store, "display").find((event) => event.type === "final_response");
  expect(final?.summary).toBe("Work complete.");
  expect(final?.text).toBe(content);
  expect(getRiskFlags(store, "display").map((flag) => flag.category)).toContain("missing-lint-evidence");
  store.db.close();
});

test("git paths that look like renames or contain control characters stay literal", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentops-git-literal-")));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=synthetic", "-c", "user.email=synthetic", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(dir, "nested"));
  const arrow = "nested/from -> to.ts";
  const bell = "nested/b\u0007é.ts";
  writeFileSync(join(dir, arrow), "export {};\n");
  writeFileSync(join(dir, bell), "export {};\n");
  writeFileSync(join(dir, "README.md"), "y\n");
  expect(getGitChanges(dir).map((change) => change.path).sort()).toEqual(["README.md", bell, arrow].sort());
});

function runAction(shell: string, artifacts: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-action-r2-"));
  const output = join(dir, "out");
  const summary = join(dir, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const proc = Bun.spawnSync([shell, join(import.meta.dir, "..", "scripts", "github-action.sh")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", AGENTOPS_BIN: "false", AGENTOPS_ARTIFACTS: artifacts, AGENTOPS_REPORT_DIR: dir,
      AGENTOPS_FAIL_ON_GATE: "false", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    stdout: "pipe",
    stderr: "pipe"
  });
  return { exitCode: proc.exitCode, outputs: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8") };
}

// /bin/bash is 3.2 on macOS, where "${empty[@]}" under set -u is an error.
const shells = ["bash", ...(existsSync("/bin/bash") ? ["/bin/bash"] : [])];
for (const shell of shells) {
  for (const [name, value] of [["an empty", ""], ["a whitespace-only", "  \n  "]] as const) {
    test(`Action (${shell}): ${name} artifacts input writes the failed status and report`, () => {
      const result = runAction(shell, value);
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toContain("status=failed");
      expect(result.outputs).toContain("failed=1");
      expect(result.summary).toContain("resolved to no paths");
    });
  }
}
