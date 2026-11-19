// Child process for the spool concurrency test: appends `count` synthetic hook
// payloads for one session and exits non-zero if any append failed.
import { appendHookPayload } from "../../src/recorder/spool";

const [dir, sessionId, countArg, tag] = process.argv.slice(2);
let failures = 0;
for (let i = 0; i < Number(countArg); i++) {
  const result = appendHookPayload(
    dir,
    {
      session_id: sessionId,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: `toolu_${tag}${String(i).padStart(4, "0")}`.padEnd(30, "0"),
      tool_input: { command: "bun test", description: `writer ${tag} call ${i}` },
      tool_response: { stdout: `1 pass ${tag} ${i}`, stderr: "", interrupted: false, isImage: false }
    },
    { lockTimeoutMs: 5000 }
  );
  if (!result.ok) failures += 1;
}
process.exit(failures === 0 ? 0 : 1);
