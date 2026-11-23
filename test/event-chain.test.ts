import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { canonicalJson, chainEvents, checkChain, contentHash, eventHash, eventIdFor } from "../src/eventChain";
import { parseJsonlTranscript } from "../src/parser";
import { generateMarkdownReport } from "../src/report";
import { ingestTranscript, openStore } from "../src/store";
import type { RawEvent } from "../src/types";

describe("canonicalJson", () => {
  test("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [3, { y: true, x: null }, "s"] })).toBe('{"a":[3,{"x":null,"y":true},"s"],"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("orders keys by UTF-16 code unit", () => {
    expect(canonicalJson({ "é": 1, z: 2, A: 3, "10": 4, "9": 5 })).toBe('{"10":4,"9":5,"A":3,"z":2,"é":1}');
  });

  test("serializes strings and numbers like JSON.stringify", () => {
    expect(canonicalJson(["line\n\t\"q\"", 1e21, 0.1, -0, 5])).toBe('["line\\n\\t\\"q\\"",1e+21,0.1,0,5]');
  });

  test("drops undefined members and nulls undefined array items", () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  test("rejects values with no stable JSON form", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow("non-finite number at $.n");
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow("non-finite number at $[0]");
    expect(() => canonicalJson({ big: 1n })).toThrow("unsupported bigint at $.big");
    expect(() => canonicalJson(undefined)).toThrow("top-level value");
  });
});

describe("eventHash and contentHash", () => {
  const event: RawEvent = { schemaVersion: "agentops.event.v1", type: "command", input: { cmd: "bun test" }, exitCode: 0, eventId: "s:1", seq: 1, prevHash: null };

  test("is a fixed sha256 of the canonical form (format lock)", () => {
    // Cross-checked with: printf '%s' '<canonical>' | shasum -a 256
    expect(canonicalJson(event)).toBe('{"eventId":"s:1","exitCode":0,"input":{"cmd":"bun test"},"prevHash":null,"schemaVersion":"agentops.event.v1","seq":1,"type":"command"}');
    expect(eventHash(event)).toBe("339d99d67e42f51bf0e7e38d10170359e226f9232e975fbfaa6c78d5f1f6644b");
  });

  test("ignores the event's own hash and key order", () => {
    expect(eventHash({ ...event, hash: "anything" })).toBe(eventHash(event));
    const reordered = Object.fromEntries(Object.entries(event).reverse()) as RawEvent;
    expect(eventHash(reordered)).toBe(eventHash(event));
  });

  test("changes when any other field changes", () => {
    expect(eventHash({ ...event, exitCode: 1 })).not.toBe(eventHash(event));
    expect(eventHash({ ...event, prevHash: "0".repeat(64) })).not.toBe(eventHash(event));
  });

  test("contentHash is sha256 hex of the content", () => {
    expect(contentHash("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("chainEvents and checkChain", () => {
  const events: RawEvent[] = [
    { type: "message", role: "user", content: "fix add" },
    { type: "command", input: { cmd: "bun test" }, exitCode: 1 },
    { type: "file_edit", path: "math.js", operation: "edit" },
    { type: "final_response", content: "Fixed." },
  ];

  test("assigns seq from 1, eventIds and linked hashes without mutating input", () => {
    const before = JSON.stringify(events);
    const chained = chainEvents("s", events);
    expect(JSON.stringify(events)).toBe(before);
    expect(chained.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(chained.map((e) => e.eventId)).toEqual(["s:1", "s:2", "s:3", "s:4"]);
    expect(chained[0].prevHash).toBeNull();
    for (let i = 1; i < chained.length; i++) expect(chained[i].prevHash).toBe(chained[i - 1].hash);
    expect(eventIdFor("s", 7)).toBe("s:7");
  });

  test("continuing from a chain head equals chaining in one pass", () => {
    const whole = chainEvents("s", events);
    const head = chainEvents("s", events.slice(0, 2));
    const tail = chainEvents("s", events.slice(2), { seq: 3, prevHash: head[1].hash as string });
    expect([...head, ...tail]).toEqual(whole);
    expect(chainEvents("s", whole)).toEqual(whole);
  });

  test("a fresh chain is valid and reports its head", () => {
    const chained = chainEvents("s", events);
    expect(checkChain(chained)).toEqual({ status: "valid", count: 4, headHash: chained[3].hash as string });
    expect(checkChain(chained.slice(2))).toMatchObject({ status: "valid", count: 2 });
  });

  test("legacy events with no chain fields are unchained, not broken", () => {
    expect(checkChain(events)).toEqual({ status: "unchained" });
    expect(checkChain([])).toEqual({ status: "unchained" });
  });

  test("names the first broken record", () => {
    const chained = chainEvents("s", events);
    const tampered = chained.map((e, i) => (i === 2 ? { ...e, path: "other.js" } : e));
    expect(checkChain(tampered)).toEqual({ status: "broken", index: 2, reason: "hash-mismatch" });

    expect(checkChain([chained[0], chained[2], chained[3]])).toEqual({ status: "broken", index: 1, reason: "seq-gap" });

    const relinked = chained.map((e, i) => (i === 3 ? { ...e, prevHash: chained[1].hash } : e));
    expect(checkChain(relinked)).toEqual({ status: "broken", index: 3, reason: "prev-hash" });

    const stripped = chained.map((e, i) => (i === 1 ? { ...e, hash: undefined } : e));
    expect(checkChain(stripped)).toEqual({ status: "broken", index: 1, reason: "missing-fields" });

    expect(checkChain([{ ...chained[0], prevHash: "f".repeat(64), hash: undefined }].map((e) => ({ ...e, hash: eventHash(e) })))).toEqual({
      status: "broken",
      index: 0,
      reason: "prev-hash",
    });
  });
});

test("the chained report matches the golden output with its source event ID in the ledger citation", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentops-chain-golden-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript("fixtures/sample-session.jsonl", readFileSync("fixtures/sample-session.jsonl", "utf8"));
  expect(checkChain(transcript.events)).toEqual({ status: "unchained" });

  const chained = { ...transcript, events: chainEvents(transcript.session.id, transcript.events) };
  expect(checkChain(chained.events).status).toBe("valid");
  // Store raw payloads so the test can prove the chain fields reached the store.
  const config = { ...defaultConfig, privacy: { ...defaultConfig.privacy, storeRawPayload: true } };
  ingestTranscript(store, chained, config);
  analyzeSession(store, "sample-session", config);

  const stored = store.db.query("SELECT raw_json AS rawJson FROM events WHERE session_id = 'sample-session' ORDER BY idx").all() as Array<{ rawJson: string }>;
  expect(stored.length).toBe(chained.events.length);
  expect(stored.every((row) => row.rawJson.includes('"prevHash"') && row.rawJson.includes('"hash"'))).toBe(true);

  const golden = readFileSync("fixtures/golden/sample-report.md", "utf8");
  const citation = "[step 7](#event-step-7)";
  expect(golden).toContain(citation);
  expect(generateMarkdownReport(store, "sample-session", config)).toBe(golden.replace(citation, citation + " (sample-session:7)"));
  store.db.close();
});
