// Synthetic demo sessions, embedded at build time (Bun `with { type: "text" }`)
// so `agentops demo` works from an installed binary in any directory, not only
// from a source checkout where `fixtures/` exists.
import forensicTerminal from "../fixtures/forensic-terminal-transcript.txt" with { type: "text" };
import needsReview from "../fixtures/needs-review-session.jsonl" with { type: "text" };
import risky from "../fixtures/risky-session.jsonl" with { type: "text" };
import sample from "../fixtures/sample-session.jsonl" with { type: "text" };
import type { AdapterInput } from "./adapters";

export const demoFixtures: ReadonlyArray<{ input: AdapterInput; state: string }> = [
  { input: { sourcePath: "fixtures/sample-session.jsonl", content: sample as unknown as string }, state: "ready" },
  { input: { sourcePath: "fixtures/needs-review-session.jsonl", content: needsReview as unknown as string }, state: "needs review" },
  { input: { sourcePath: "fixtures/risky-session.jsonl", content: risky as unknown as string }, state: "blocked" },
  { input: { sourcePath: "fixtures/forensic-terminal-transcript.txt", content: forensicTerminal as unknown as string }, state: "forensic" }
];
