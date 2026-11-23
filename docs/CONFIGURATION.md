# Configuration Strategy

## Decision

Use a project-local optional config file:

```text
agentops.config.json
```

The CLI should work without config. Config should refine behavior, not be required for the happy path.

Validate config changes with:

```bash
./bin/agentops config --check
```

`agentops.config.v1` is stable in `v1.0.0`. New config keys should be optional
and have safe defaults. See [Compatibility policy](COMPATIBILITY.md).

## Initial Config Surface

```json
{
  "schemaVersion": "agentops.config.v1",
  "privacy": {
    "storeRawPayload": false,
    "hashRawPayload": true,
    "redactBeforeStore": true
  },
  "risk": {
    "largeChurnLines": 500,
    "repeatedEditThreshold": 6,
    "treatBlockedAsExecuted": false,
    "sensitivePaths": [".env", ".npmrc", "secrets.json"],
    "productionPathPatterns": ["prod", "production", "deploy", "terraform", "k8s"]
  },
  "evidence": {
    "verificationCommands": ["test", "lint", "typecheck", "build"]
  },
  "gates": {
    "requireVerification": true,
    "requiredVerificationCommands": [],
    "maxHighSeverityRisks": 0,
    "maxBlockedAttempts": 2,
    "allowUnsupportedFinalClaims": false,
    "maxGeneratedFileChurnLines": 0,
    "generatedFilePatterns": ["generated", "dist", "build"]
  },
  "suppressions": [
    {
      "category": "large-churn",
      "path": "generated/example.ts",
      "reason": "Generated output is expected for this task type."
    }
  ]
}
```

## Why Config Helps

Different repos have different risk profiles:

- generated files may be expected in one repo and risky in another
- deployment paths differ by team
- test commands differ by stack
- CI gates differ by repository
- line churn thresholds differ by project
- some findings need explicit suppressions

## Drawbacks

### More Complexity

Config introduces precedence questions:

- CLI flag vs config file
- default rule vs user rule
- suppression vs high-severity finding

Mitigation: keep v1 config small and document precedence clearly.

### Suppression Abuse

Teams can hide useful findings with broad suppressions.

Mitigation: require suppressions to include a narrow `category`, `path` or
`command`, and `reason`. `agentops config --check` fails if a suppression omits
these fields.

### Public Fixture Risk

Config examples can leak real path names or private repo conventions.

Mitigation: ship only synthetic examples.

### Compatibility Burden

Once public, config keys become user-facing API.

Mitigation: include `schemaVersion` from day one.

## Performance Notes

Config parsing is not a meaningful performance risk. The heavy operations are:

- scanning large raw transcript payloads
- regex checks over command output
- hashing raw payloads
- writing many events to SQLite
- future git diff correlation

Expected MVP performance:

- small sessions: effectively instant
- hundreds of events: SQLite transaction should remain fast
- thousands of events: still reasonable if inserts are batched; `bun run
  smoke:large-session` currently validates a 2,500-event synthetic session
- large command outputs: redaction/scanning may dominate runtime

## Storage Tradeoffs

### Store Raw Payloads

Pros:

- better debugging
- easier adapter development
- future re-analysis without re-ingest

Cons:

- highest privacy risk
- larger SQLite database
- harder public/demo hygiene

Recommendation: off by default.

### Store Redacted Raw Payloads

Pros:

- preserves useful debugging context
- lower privacy risk than raw storage

Cons:

- redaction can miss things
- still grows the database
- needs tests and explicit user trust

Recommendation: optional after redaction is tested.

### Store Hashes Only

Pros:

- lowest privacy risk
- allows integrity checks
- small storage footprint

Cons:

- less useful for debugging parser issues
- cannot re-run future analyzers on raw payload

Recommendation: default for MVP.

## Recommended V1 Defaults

- `storeRawPayload: false`
- `hashRawPayload: true`
- `redactBeforeStore: true`
- deterministic analyzer rules
- explicit suppressions only
- no network calls

## Claim Support Commands

`evidence.supportCommands` lists, per claim kind (`test`, `lint`, `typecheck`,
`build`), the exact commands that can support a final-response claim in the
claims ledger. A passing run supports a claim only when its command equals one
of these, word for word. A kind listed here replaces its built-in list; kinds
left out keep theirs. For example, a repository whose CI script runs the test
suite:

```json
{
  "evidence": {
    "supportCommands": { "test": ["bun test", "bun run ci"] }
  }
}
```

Entries are trusted as written, environment assignments and program-specific
flags included: the list is the repository's statement of what runs its checks,
so leave out forms that do not actually run them (`make -n test`). The config
check refuses only what the ledger can verify is not a run: shell syntax (`;`,
`&&`, `|`, `$(...)`, quotes), `!` negation, and the flags `-h`, `--help`, `-V`,
`--version`, `--dry-run`, `--list` and `--collect-only`. A failed run of a configured command
contradicts the claim, as does any failed run that mentions the kind. See [QUALITY_GATES.md](QUALITY_GATES.md) for the ledger rules.

## Suppression Matching

Suppressions are intentionally narrow. A suppression can match by:

- `category`
- `path`
- `command`

At least one of those fields must be present. `reason` is recommended for reviewability.
As of `v0.7.0`, `reason` is required by `agentops config --check`.

Example:

```json
{
  "category": "large-churn",
  "path": "generated/example.ts",
  "reason": "Generated output is expected for this task type."
}
```

## Future Config Areas

- adapter-specific settings
- report templates
- OpenTelemetry export settings
- dashboard preferences
- org/team policy packs
- CI failure thresholds
