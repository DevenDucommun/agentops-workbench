import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { analyzeSession } from "../src/analyzer";
import { defaultConfig } from "../src/config";
import { generateOpenInferenceJsonExport, generateRepoJsonExport, generateSessionJsonExport } from "../src/export";
import { parseJsonlTranscript } from "../src/parser";
import { ingestTranscript, openStore } from "../src/store";

test("exports deterministic session JSON without raw payloads by default", () => {
  const store = openFixture("fixtures/sample-session.jsonl");
  analyzeSession(store, "sample-session", defaultConfig);

  const first = generateSessionJsonExport(store, "sample-session", defaultConfig);
  const second = generateSessionJsonExport(store, "sample-session", defaultConfig);
  const payload = JSON.parse(first) as {
    schemaVersion: string;
    kind: string;
    session: { id: string; sourcePath?: string };
    events: Array<{ rawJson?: string; rawPayloadHash: string | null }>;
    commands: unknown[];
    files: unknown[];
    risks: unknown[];
    verification: unknown[];
  };

  expect(first).toBe(second);
  expect(payload.schemaVersion).toBe("agentops.export.v1");
  expect(payload.kind).toBe("session");
  expect(payload.session.id).toBe("sample-session");
  expect(payload.session.sourcePath).toBeUndefined();
  expect(payload.events.length).toBeGreaterThan(0);
  expect(payload.events.every((event) => event.rawJson === undefined)).toBe(true);
  expect(payload.events.every((event) => typeof event.rawPayloadHash === "string")).toBe(true);
  expect(payload.commands.length).toBeGreaterThan(0);
  expect(payload.files.length).toBeGreaterThan(0);
  expect(payload.risks).toEqual([]);
  expect(payload.verification.length).toBeGreaterThan(0);

  store.db.close();
});

test("exports repo JSON with observed and unobserved git coverage", () => {
  const store = openFixture("fixtures/sample-session.jsonl");
  analyzeSession(store, "sample-session", defaultConfig);

  const payload = JSON.parse(
    generateRepoJsonExport(
      store,
      "sample-session",
      [
        { path: "src/server.ts", status: "M", additions: 4, deletions: 0 },
        { path: "docs/new-note.md", status: "??", additions: null, deletions: null }
      ],
      defaultConfig
    )
  ) as {
    kind: string;
    git: {
      changes: Array<{ path: string }>;
      observedChanges: Array<{ path: string }>;
      unobservedChanges: Array<{ path: string }>;
      agentOnlyFiles: Array<{ path: string }>;
    };
  };

  expect(payload.kind).toBe("repo");
  expect(payload.git.changes.map((change) => change.path)).toEqual(["src/server.ts", "docs/new-note.md"]);
  expect(payload.git.observedChanges.map((change) => change.path)).toEqual(["src/server.ts"]);
  expect(payload.git.unobservedChanges.map((change) => change.path)).toEqual(["docs/new-note.md"]);
  expect(payload.git.agentOnlyFiles.map((file) => file.path)).toContain("test/server.test.ts");

  store.db.close();
});

test("exports deterministic OpenInference-style spans without raw payloads", () => {
  const store = openFixture("fixtures/sample-session.jsonl");
  analyzeSession(store, "sample-session", defaultConfig);

  const first = generateOpenInferenceJsonExport(store, "sample-session", defaultConfig);
  const second = generateOpenInferenceJsonExport(store, "sample-session", defaultConfig);
  const payload = JSON.parse(first) as {
    schemaVersion: string;
    kind: string;
    session: { id: string; sourcePath?: string };
    spans: Array<{
      traceId: string;
      spanId: string;
      parentSpanId: string | null;
      name: string;
      attributes: Record<string, unknown>;
      rawJson?: string;
    }>;
  };

  expect(first).toBe(second);
  expect(payload.schemaVersion).toBe("agentops.openinference.v1");
  expect(payload.kind).toBe("openinference");
  expect(payload.session.id).toBe("sample-session");
  expect(payload.session.sourcePath).toBeUndefined();
  expect(payload.spans.length).toBeGreaterThan(1);
  expect(payload.spans[0].attributes["openinference.span.kind"]).toBe("AGENT");
  expect(payload.spans.some((span) => span.attributes["openinference.span.kind"] === "TOOL")).toBe(true);
  expect(payload.spans.some((span) => span.attributes["agentops.raw_payload.hash"])).toBe(true);
  expect(JSON.stringify(payload)).not.toContain("rawJson");

  store.db.close();
});

function openFixture(path: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentops-export-test-"));
  const store = openStore(join(dir, "agentops.db"));
  const transcript = parseJsonlTranscript(path, readFileSync(path, "utf8"));
  ingestTranscript(store, transcript, defaultConfig);
  return store;
}
