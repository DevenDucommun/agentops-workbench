# Claude Code hook fixtures

Synthetic raw hook payloads, one JSON object per line, exactly as a command
hook receives them on stdin. They follow the field names, types, key order
and event order recorded in
[spike-s1.md](../../docs/specs/forensic-recorder/spike-s1.md) (Claude Code
2.1.328). Every value is invented: paths sit under `/workspace/demo-repo` and
`/synthetic`, and IDs are made up in the observed formats.

| File | Covers |
|------|--------|
| `clean-session.jsonl` | Read, Edit, passing `bun test`; `SessionEnd` reason `prompt_input_exit` |
| `risky-session.jsonl` | `rm -rf`, a `.env` write, minified output with no whitespace, and a rejected `git push --force` (`PostToolUseFailure`) |
| `subagent-session.jsonl` | An Explore subagent (`SubagentStart`/`SubagentStop`, Grep and Read inside it) linked by `agent_id` to the parent `Agent` call |
| `failing-test-session.jsonl` | A failing `bun test` as `PostToolUseFailure`, the fix, then a passing run |
| `commit-session.jsonl` | Edit plus Write in one turn, a commit with `gitOperation.commit` (short SHA), then a `--resume` segment under the same `session_id` |

Hook payloads carry no timestamps. The spool writer (T1.3) adds receive time.
The redaction-cost regression input (a 20 KB single token, see spike S1)
belongs in the T1.3 redaction test, which generates it in code rather than
storing it here.
`test/claude-hook-fixtures.test.ts` checks the structural invariants.
