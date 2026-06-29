import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type PublicationFinding = {
  file: string;
  line: number;
  rule: string;
  text: string;
};

type PublicationScanOptions = {
  rootDir?: string;
};

const ignoredDirs = new Set([".git", ".agentops", ".agents", "Plans", "node_modules", "dist"]);
const ignoredExtensions = new Set([".db", ".sqlite", ".sqlite3", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ignoredFiles = new Set([
  "scripts/public-readiness.ts",
  "docs/PUBLICATION_AND_PRIVACY.md",
  "src/analyzer.ts",
  "src/publicationScan.ts"
]);

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

export function scanPublication(options: PublicationScanOptions = {}): PublicationFinding[] {
  const rootDir = options.rootDir ?? ".";
  const findings: PublicationFinding[] = [];

  for (const file of walk(rootDir, ".")) {
    if (ignoredFiles.has(file)) continue;
    const content = readFileSync(join(rootDir, file), "utf8");
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

  return findings;
}

export function formatPublicationScanResult(findings: PublicationFinding[]): string {
  if (findings.length === 0) return "Public-readiness scan passed.\n";

  const lines = ["Public-readiness scan failed:"];
  for (const finding of findings) {
    lines.push(`${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
  }
  return `${lines.join("\n")}\n`;
}

function* walk(rootDir: string, dir: string): Generator<string> {
  for (const entry of readdirSync(join(rootDir, dir))) {
    if (ignoredDirs.has(entry)) continue;
    const path = join(dir, entry);
    const absolutePath = join(rootDir, path);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      yield* walk(rootDir, path);
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
