import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { parseForensicTextTranscript } from "../src/forensicText";

function commands(text: string) {
  return parseForensicTextTranscript("terminal.txt", text, defaultConfig)
    .events.filter((event) => event.type === "tool_call")
    .map((event) => ({ command: event.command, status: event.status, exitCode: event.exitCode }));
}

test("each prompt line is its own execution, and exit codes stay with their command", () => {
  const text = [
    "$ bun test",
    "1 fail",
    "Process exited with code 1",
    "$ git status",
    "nothing to commit, working tree clean",
    "$ bun test",
    "1 fail",
    "Process exited with code 1",
    "Tests still fail."
  ].join("\n");
  expect(commands(text)).toEqual([
    { command: "bun test", status: "observed", exitCode: 1 },
    { command: "git status", status: "observed", exitCode: undefined },
    { command: "bun test", status: "observed", exitCode: 1 }
  ]);
});

test("a second exit line does not overwrite a command's exit code", () => {
  const text = ["$ bun test", "Process exited with code 1", "exit code 0", "Done."].join("\n");
  expect(commands(text)).toEqual([{ command: "bun test", status: "observed", exitCode: 1 }]);
});

test("a command only mentioned in prose is recorded once", () => {
  const text = ["I will run `bun test` next.", "Then `bun test` again.", "Done."].join("\n");
  expect(commands(text).map((entry) => entry.status)).toEqual(["inferred"]);
});
