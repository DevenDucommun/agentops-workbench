import { sha256 } from "./redaction";
import type { RawEvent } from "./types";

// Canonical JSON and per-session hash chains for agentops.event.v1 records
// (forensic recorder spec R1.5). The recorder writes the chain fields from day
// one; verification (`agentops verify`) ships in M4 and builds on checkChain.

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit at every level, no
 * whitespace, strings and numbers serialized as JSON.stringify does. For plain
 * JSON values this matches RFC 8785 (JCS). Undefined object members are
 * dropped and undefined array items become null, like JSON.stringify.
 * Non-finite numbers, bigints, functions and symbols are rejected because they
 * have no stable JSON form.
 */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value, "$");
  if (out === undefined) throw new TypeError("canonicalJson: top-level value is not representable as JSON");
  return out;
}

function canonicalize(value: unknown, path: string): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return undefined;
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => canonicalize(item, `${path}[${i}]`) ?? "null").join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = canonicalize(record[key], `${path}.${key}`);
        if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/** sha256 (hex) of the canonical JSON of the event with its own `hash` removed. */
export function eventHash(event: RawEvent): string {
  const { hash: _ignored, ...rest } = event;
  return sha256(canonicalJson(rest));
}

/** sha256 (hex) of file content as written (UTF-8), for `contentHash`. */
export function contentHash(content: string): string {
  return sha256(content);
}

/** Event IDs are opaque strings; the recorder uses `<sessionId>:<seq>`. */
export function eventIdFor(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}`;
}

export type ChainStart = { seq: number; prevHash: string | null };

/**
 * Returns copies of `events` carrying eventId, seq, prevHash and hash. A new
 * session starts at seq 1 with prevHash null; pass `start` to continue an
 * existing chain (the spool writer resumes from its file tail).
 */
export function chainEvents(sessionId: string, events: RawEvent[], start: ChainStart = { seq: 1, prevHash: null }): RawEvent[] {
  let seq = start.seq;
  let prevHash = start.prevHash;
  return events.map((event) => {
    const { eventId: _e, seq: _s, prevHash: _p, hash: _h, ...rest } = event;
    const linked: RawEvent = { ...rest, eventId: eventIdFor(sessionId, seq), seq, prevHash };
    linked.hash = eventHash(linked);
    prevHash = linked.hash;
    seq += 1;
    return linked;
  });
}

export type ChainCheck =
  | { status: "valid"; count: number; headHash: string | null }
  | { status: "unchained" }
  | { status: "broken"; index: number; reason: "missing-fields" | "seq-gap" | "prev-hash" | "hash-mismatch" };

/**
 * Checks a session's events in order. Events with no chain fields at all
 * (legacy imports) are `unchained`, not broken. The first record may start at
 * any seq; a chain that starts at seq 1 must have prevHash null.
 */
export function checkChain(events: RawEvent[]): ChainCheck {
  const hasChain = (e: RawEvent) => e.hash !== undefined || e.seq !== undefined || e.prevHash !== undefined;
  if (events.length === 0 || !events.some(hasChain)) return { status: "unchained" };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (typeof event.hash !== "string" || typeof event.seq !== "number" || event.prevHash === undefined) {
      return { status: "broken", index: i, reason: "missing-fields" };
    }
    if (i === 0) {
      if (event.seq === 1 && event.prevHash !== null) return { status: "broken", index: i, reason: "prev-hash" };
    } else {
      const prev = events[i - 1];
      if (event.seq !== (prev.seq as number) + 1) return { status: "broken", index: i, reason: "seq-gap" };
      if (event.prevHash !== prev.hash) return { status: "broken", index: i, reason: "prev-hash" };
    }
    if (eventHash(event) !== event.hash) return { status: "broken", index: i, reason: "hash-mismatch" };
  }
  return { status: "valid", count: events.length, headHash: (events.at(-1)?.hash as string | undefined) ?? null };
}
