import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runCli } from "../src/cli";
import { formatPublicationScanResult, scanPublication } from "../src/publicationScan";

test("publication scan reports suspicious public content", () => {
  const root = join(tmpdir(), `agentops-publication-scan-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const syntheticEmail = `person${"@"}example.test`;
  writeFileSync(join(root, "README.md"), `Contact ${syntheticEmail}\n`);

  const findings = scanPublication({ rootDir: root });
  expect(findings).toEqual([
    {
      file: "README.md",
      line: 1,
      rule: "email",
      text: `Contact ${syntheticEmail}`
    }
  ]);
  expect(formatPublicationScanResult(findings)).toContain("Public-readiness scan failed:");
});

test("scan-publication CLI command passes for the repository", async () => {
  const result = await runCli(["scan-publication"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Public-readiness scan passed.");
});
