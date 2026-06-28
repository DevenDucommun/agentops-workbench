import { createHash } from "node:crypto";

const redactionRules: Array<[string, RegExp]> = [
  ["local-path", /(?:\/Users\/|\/home\/|\/Volumes\/)[^\s)`'"]+/g],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["aws-access-key", /AKIA[0-9A-Z]{16}/g],
  ["openai-style-key", /sk-[A-Za-z0-9_-]{20,}/g],
  ["github-token", /ghp_[A-Za-z0-9_]{20,}/g],
  ["slack-token", /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["private-key", /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g]
];

export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = redactValue(child);
    }
    return result as T;
  }
  return value;
}

export function redactString(input: string): string {
  let output = input;
  for (const [label, pattern] of redactionRules) {
    output = output.replace(pattern, `[REDACTED:${label}]`);
  }
  return output;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
