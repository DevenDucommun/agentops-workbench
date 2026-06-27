import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Finding = {
  file: string;
  line: number;
  rule: string;
  text: string;
};

const ignoredDirs = new Set([".git", ".agentops", ".agents", "node_modules", "dist"]);
const ignoredExtensions = new Set([".db", ".sqlite", ".sqlite3", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ignoredFiles = new Set(["scripts/public-readiness.ts", "docs/PUBLICATION_AND_PRIVACY.md", "src/analyzer.ts"]);

const rules: Array<[string, RegExp]> = [
  ["local-path", /(?:\/Users\/|\/home\/|\/Volumes\/)[^\s)`'"]+/],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/],
  ["github-token", /ghp_[A-Za-z0-9_]{20,}/],
  ["slack-token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private-key", /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
  ["private-pai-root", /PAI_DATA_ROOT/]
];

const findings: Finding[] = [];

for (const file of walk(".")) {
  if (ignoredFiles.has(file)) continue;
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const [rule, pattern] of rules) {
      if (pattern.test(line)) {
        findings.push({
          file,
          line: index + 1,
          rule,
          text: line.trim().slice(0, 180)
        });
      }
    }
  });
}

if (findings.length > 0) {
  console.error("Public-readiness scan failed:");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
  }
  process.exit(1);
}

console.log("Public-readiness scan passed.");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (!stats.isFile()) continue;
    if (ignoredExtensions.has(extension(path))) continue;
    yield relative(".", path);
  }
}

function extension(path: string): string {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0] ?? "";
}
