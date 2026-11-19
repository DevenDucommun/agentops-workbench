import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { scanPublication } from "../src/publicationScan";
import { redactString, redactValue } from "../src/redaction";

// Built at runtime so the publication scan does not flag this file.
const at = "@";

test("redacts ordinary email addresses", () => {
  const cases = [
    `contact jane.doe+tag${at}example.org now`,
    `<a.b${at}sub.example.co.uk>`,
    `mailto:x_y%z${at}host.io`,
  ];
  for (const input of cases) {
    const output = redactString(input);
    expect(output).toContain("[REDACTED:email]");
    expect(output).not.toContain(at);
  }
});

test("leaves non-addresses alone", () => {
  for (const input of [`user${at}localhost`, `v1.2.3${at}4.5`, `ok${at}a.b`]) {
    expect(redactString(input)).toBe(input);
  }
});

test("an over-long local part still hides the domain", () => {
  const output = redactString(`${"x".repeat(80)}${at}example.com`);
  expect(output).toContain("[REDACTED:email]");
  expect(output).not.toContain("example.com");
});

// Regression: the unbounded pattern was quadratic on long runs of local-part
// characters with no "@" (about 2.6 s for 100 KB). Bounded, it takes a few ms.
// The limit is generous so slow CI runners do not flake.
const longInputs: Record<string, string> = {
  "single token": "x".repeat(200_000),
  "domain run after @": `a${at}${"b".repeat(200_000)}`,
  "dotted run without a TLD": `a${at}${"b.".repeat(100_000)}1`,
};

for (const [name, input] of Object.entries(longInputs)) {
  test(`redaction stays fast on a 200 KB ${name}`, () => {
    const started = performance.now();
    redactValue({ tool_response: { stdout: input } });
    expect(performance.now() - started).toBeLessThan(500);
  });
}

test("publication scan stays fast on a 200 KB line", () => {
  const root = join(tmpdir(), `agentops-redaction-scan-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "bundle.min.js"), `${"x".repeat(200_000)}\n`);
  const started = performance.now();
  expect(scanPublication({ rootDir: root })).toEqual([]);
  expect(performance.now() - started).toBeLessThan(500);
});
