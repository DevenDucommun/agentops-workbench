# Installation

AgentOps Workbench is currently distributed as a source-first Bun project.

## Requirements

- Bun 1.3 or newer
- Git, when using repo-aware reports

## Recommended: Fresh Clone

Use this path for development and for repo-aware reports.

```bash
git clone https://github.com/DevenDucommun/agentops-workbench.git
cd agentops-workbench
bun install --frozen-lockfile
./bin/agentops --help
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops sessions
./bin/agentops inspect --session latest
./bin/agentops report --session latest > report.md
```

Repo-aware reports require a git checkout:

```bash
./bin/agentops repo-report --session latest > repo-report.md
./bin/agentops repo-report --session latest --format github > pr-comment.md
```

## PATH-Based Local Command

For local use without typing `./bin/` each time:

```bash
export PATH="$PWD/bin:$PATH"
agentops --help
agentops ingest ./fixtures/sample-session.jsonl
agentops sessions
```

This is the currently recommended way to use the `agentops` command from a clone.

## Bun Link

`bun link` can expose the package binary from a local checkout, but this project is not yet published as a package and does not treat global linking as the primary install path.

Use it only for local experimentation:

```bash
bun link
agentops --help
```

If global link behavior differs across Bun versions, fall back to the PATH-based command.

## GitHub Source Archive

GitHub release source archives are useful for trying the CLI, but they are not git checkouts.

This works from an extracted source archive:

```bash
bun install --frozen-lockfile
./bin/agentops ingest ./fixtures/sample-session.jsonl
./bin/agentops sessions
./bin/agentops inspect --session latest
./bin/agentops report --session latest > report.md
```

This does not work from a source archive because `.git` is not present:

```bash
./bin/agentops repo-report --session latest
```

Use a fresh git clone when you need `repo-report`.

## Future Packaging Options

Packaging is intentionally deferred until the CLI surface stabilizes further.

Candidate paths:

- npm package with a `bin` entry
- Bun standalone executable
- GitHub release artifact containing a tested bundle

Any future package workflow should include CI or smoke verification equivalent to:

```bash
bun run smoke:install
```
