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

Records are redacted (secrets, emails, local paths) before they are written.

| Kept as text, after redaction | Kept as length + sha256 only |
| --- | --- |
| User prompts and the assistant's turn-end messages | File contents written or read |
| Bash commands and exit codes | Edit `old_string` / `new_string` |
| Repository-relative file paths, line counts | Command stdout and stderr |
| Tool names, search patterns, subagent types | Tool error text |
| Session, prompt, tool-use and agent IDs; git commit SHAs and branches | |

`privacy.storeRawPayload: true` in `agentops.config.json` keeps the right-hand
column as text too (still redacted). Claude Code's `transcript_path` fields are
dropped, and transcript files are never read.

### Where It Lives

| What | Where |
| --- | --- |
| Enrolled repositories | `<state>/recorder/enrolled.json` |
| Spools, one JSONL file per session | `<state>/spool/<session-id>.jsonl` |
| Recorder errors | `<state>/spool/<session-id>.errors.jsonl` |
| Imported sessions | `<repository>/.agentops/agentops.db` |

`<state>` is `$AGENTOPS_STATE_DIR`, else `$XDG_STATE_HOME/agentops`, else
`~/.local/state/agentops`. It is outside every repository. The store is under
`.agentops/`, which must stay in `.gitignore`.

### Retention

Nothing is deleted automatically. Spools stay after import, because they are
the source `agentops verify` (planned for M4) will check the store against.
Sessions stay in the store until you remove it.

### Removal

| To | Do |
| --- | --- |
| Stop recording a repository | `agentops recorder disable` |
| Stop recording everywhere | `claude plugin uninstall agentops-recorder` |
| Delete one session everywhere | `agentops recorder forget <session-id>`, from inside the repository |
| Delete all spools | remove `<state>/spool/` |
| Delete imported sessions for a repository | remove `<repository>/.agentops/agentops.db` |
| Remove all recorder state | remove `<state>/` |

`agentops recorder forget` deletes the session from the repository's store
(its events, commands, file changes, risk flags and commit links go with it)
and removes its spool and error files. Other sessions are untouched. It takes
the session's spool lock first: if a hook is writing to that session at that
moment, it waits up to two seconds, then gives up without removing anything.
Forget a session after it has ended; a hook that fires later starts a new
spool for it.

If you remove the whole store instead and re-import the spools you want to
keep with `agentops audit`, the re-import is partial. It restores each
session's events, tool calls, commands, file changes and risk flags, but not
the session's links to the commits it made. Only the recorder's own
session-end import creates commit links.

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
