# Configuration Strategy

## Decision

Use a project-local optional config file:

```text
agentops.config.json
```

The CLI should work without config. Config should refine behavior, not be required for the happy path.

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
    "sensitivePaths": [".env", ".npmrc", "secrets.json"],
    "productionPathPatterns": ["prod", "production", "deploy", "terraform", "k8s"]
  },
  "evidence": {
    "verificationCommands": ["test", "lint", "typecheck", "build"]
  },
  "suppressions": []
}
```

## Why Config Helps

Different repos have different risk profiles:

- generated files may be expected in one repo and risky in another
- deployment paths differ by team
- test commands differ by stack
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

Mitigation: require suppressions to include category, path or command pattern, and reason.

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
- thousands of events: still reasonable if inserts are batched
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

## Future Config Areas

- adapter-specific settings
- report templates
- OpenTelemetry export settings
- dashboard preferences
- org/team policy packs
- CI failure thresholds
