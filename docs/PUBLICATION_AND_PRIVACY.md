# Publication And Privacy Plan

## Goal

Develop privately, publish cleanly.

AgentOps Workbench is a public developer tool. Local development must still be
operated as if every committed artifact may be read by external users.

## Data Classes

### Safe To Commit

- source code
- tests
- synthetic fixtures
- redacted fixtures
- public architecture docs
- public roadmap docs
- generated reports from synthetic fixtures
- schema examples

### Do Not Commit

- raw real agent transcripts
- private PAI memory content
- local SQLite stores
- `.env` files
- credentials or tokens
- local absolute paths
- personal account identifiers
- private repo names
- terminal screenshots with private context
- generated reports from real private sessions

## Required Repo Controls

### Ignore Rules

The repo must ignore:

- `.agentops/`
- `.agents/`
- `*.db`
- `*.sqlite`
- `*.sqlite3`
- `.env`
- `.env.*`
- `node_modules/`
- `dist/`

### Fixture Policy

Fixtures must be synthetic by default. Redacted real fixtures are allowed only after:

- prompt text is removed or generalized
- command output is scrubbed
- file paths are made relative and generic
- model/provider metadata is safe
- secrets and tokens are scanned
- private repo/user/host names are removed

### Report Policy

Generated reports are publishable only if they are produced from synthetic or approved redacted fixtures.

Reports from real local sessions should be treated as private working artifacts.

## Forensic Recorder Data

The recorder plugin ([recorder guide](RECORDER.md)) writes real session data
on the user's machine. Treat it like any real transcript: it is a private
working artifact. Never commit it, and never turn it into a fixture without a
redaction review.

### What Is Kept

This section is the authoritative description of what the recorder stores.

Every string value in a record is redacted before it is written, wherever
it appears; JSON property names are not redacted. Redaction is pattern-based
and best-effort. It replaces emails, paths under
`/Users/`, `/home/` or `/Volumes/` (up to the first space or quote), and a
fixed set of secret formats: AWS access keys, OpenAI-style and GitHub tokens,
Slack tokens and PEM private keys. Anything else is kept as written, including
secrets in other formats (such as a plain `password=...` assignment) and the
rest of a home-directory path after a space. Treat the spool and the store as
sensitive local data. Before redaction,
path fields (`cwd`, `file_path`, `filePath`, `notebook_path`, `path`) that
point inside the recorded checkout are made relative to it. Paths elsewhere in
the text, such as in a command or a prompt, are not made relative, and
absolute paths outside those three prefixes (such as `/opt/...`) are kept as
written.

A record whose serialized line would exceed 1 MiB is truncated as a whole: its
entire payload, after redaction and the digests below, is replaced by a single
length and sha256 of that payload, and the record is marked `truncated`. This
depends on the size of the whole record, not of any one field, so several
large fields that each stay under 1 MiB can trigger it together. Everything in
the payload is then lost as text, including the prompt or command it carried.
Record metadata outside the payload is kept: the hook event, tool name,
tool-use, prompt and agent IDs, agent type, working directory, file path, line
counts, exit code, content hashes and a pushed commit. The session ID is part
of the payload, so the payload no longer carries it, but the record's
`eventId` is built from it and the spool file is named after the session, so
both still identify it.

| Kept as text, after redaction | Kept as length + sha256 only |
| --- | --- |
| User prompts and the assistant's turn-end messages | File contents written or read |
| Bash commands and exit codes | Edit `old_string` / `new_string` |
| Repository-relative file paths, line counts | Command stdout and stderr |
| Tool names, search patterns, subagent types | Tool error text |
| Subagent prompts and the text a subagent returns, which can quote file contents | |
| Notebook cell source written with NotebookEdit | |
| Session, prompt, tool-use and agent IDs; git commit SHAs and branches | |

Only the fields in the right-hand column are reduced to a digest; everything
else on the left, including subagent results, is kept as text after redaction.
`privacy.storeRawPayload: true` in `agentops.config.json` keeps the right-hand
column as text too (still redacted). Claude Code's `transcript_path` fields are
dropped, and transcript files are never read.

Fields the table doesn't name are kept in the spool as they arrive, after
redaction. `agentops audit` and the session-end import store only the top-level
fields the adapter reads, so other top-level fields stay in the spool only.
Fields nested inside an object the adapter does store (such as commit
metadata) can reach the SQLite store when `privacy.storeRawPayload` is
`true`.

### Where It Lives

| What | Where |
| --- | --- |
| Enrolled repositories | `<state>/recorder/enrolled.json` |
| Spools, one JSONL file per session | `<state>/spool/<session-id>.jsonl` |
| Recorder errors | `<state>/spool/<session-id>.errors.jsonl` |
| Imported sessions | `$AGENTOPS_DB` when set, else `<repository>/.agentops/agentops.db` |

`<state>` is `$AGENTOPS_STATE_DIR`, else `$XDG_STATE_HOME/agentops`, else
`~/.local/state/agentops`. The defaults are outside every repository; if you
point `AGENTOPS_STATE_DIR` inside a checkout, its spools and registry show up
as untracked files, so keep it outside or ignore it. The default store is under
`.agentops/`, which must stay in `.gitignore`. `agentops recorder status` names
the store in use.

### Retention

Nothing is deleted automatically. Spools stay after import, because they are
the source `agentops verify` (planned for M4) will check the store against.
Sessions stay in the store until you remove it.

### Removal

| To | Do |
| --- | --- |
| Stop recording a repository | `agentops recorder disable` |
| Stop recording everywhere | `claude plugin uninstall agentops-recorder` |
| Delete one session's spool | remove `<state>/spool/<session-id>.jsonl` and its `.errors.jsonl` |
| Delete all spools | remove `<state>/spool/` |
| Delete imported sessions for a repository | remove the store `agentops recorder status` names (`$AGENTOPS_DB` when set, else `<repository>/.agentops/agentops.db`) |
| Remove all recorder state | remove `<state>/recorder/` and `<state>/spool/`, then the store of every repository you recorded. `<state>/recorder/enrolled.json` lists only repositories still enabled (disabling one removes it from the list), so include disabled ones too. Repositories that point `AGENTOPS_DB` at the same file share one store, and deleting it removes all of their sessions. A shared `AGENTOPS_STATE_DIR` may hold other files, so remove only those two folders |

No command deletes a single session from the store yet. The store can hold
every imported session, including other tools' imports, so removing it removes
all of them. To keep some, re-import their spools afterwards with
`agentops audit <state>/spool/<session-id>.jsonl`, run from the recorded
repository. That restores each session's events, tool calls, commands, file
changes and commit links. Risk flags are recomputed under the configuration in
effect when you import, so they can differ from the original import. A commit
recorded by its abbreviated SHA is linked by its full SHA when the spool also
records it in full (a push does) or the commit exists in the repository the
import runs in; otherwise the link keeps the abbreviated SHA.

## Public Release Checklist

- Run secret scanner.
- Run local path and PII grep.
- Confirm no SQLite databases are tracked.
- Confirm no `.agentops/` or `.agents/` contents are tracked.
- Confirm all fixtures are synthetic or approved redacted.
- Confirm docs do not expose private PAI deployment details.
- Add license.
- Add `SECURITY.md`.
- Add `CONTRIBUTING.md`.
- Add CI workflow.
- Confirm fresh clone install/test instructions work.

## Suggested Scans

```bash
rg -n "/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}" .
```

```bash
find . -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3"
```

Use a dedicated secret scanner before launch as well. The shell checks above are only a baseline.

## GitHub Repo Plan

Create the GitHub repository as private first. Keep it private until the public release checklist passes.

Recommended initial settings:

- visibility: private
- branch protection: enabled before public launch, or earlier if the GitHub account plan supports it for private repositories
- issues: enabled
- discussions: optional
- wiki: disabled
- secret scanning: enabled if available
- dependabot alerts: enabled

## Intended Branch Protection

GitHub branch protection/rulesets may require GitHub Pro for private personal repositories. If unavailable while private, enable these settings as soon as the repository is public or the account plan supports them:

- protect `main`
- require pull request before merge
- require one approving review
- dismiss stale approvals on new pushes
- require status check `Test`
- require branches to be up to date before merge
- require conversation resolution
- require linear history
- block force pushes
- block branch deletion

Suggested public repository description:

> Local observability, risk analysis, and audit reporting for AI coding-agent sessions.
