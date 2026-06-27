# Decision 0001: Post-Hoc PAI Integration First

Date: 2026-06-27

## Status

Accepted.

## Context

AgentOps Workbench should work with a current local PAI deployment while remaining public-safe and useful to people who do not use PAI. The project also needs a path to Claude and Codex support.

## Decision

Build PAI support as a post-hoc sanitized export/import path first.

PAI exports or mirrors a bounded `agentops-event-v1` JSONL artifact. AgentOps ingests the artifact using the same adapter contract used by Claude, Codex, and future agent runtimes.

## Consequences

Positive:

- avoids direct access to private PAI memory stores
- keeps the public repo safe to explain
- supports Claude/Codex through the same normalized model
- makes fixtures and tests synthetic-friendly
- preserves a path to deeper hook integration later

Negative:

- not real-time at first
- depends on a separate export step
- may lose some source-specific detail unless the export includes it
- requires careful schema design before richer integrations

## Future Revisit

Revisit direct hook integration after:

- redaction pipeline exists
- config and suppressions exist
- PAI export fixture passes public-readiness checks
- direct Claude/Codex fixture strategy is clear
