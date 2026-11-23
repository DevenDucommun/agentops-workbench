import { isSafeSupportCommand } from "./ledger";

export function verificationInvocation(command: string): { runner: string; args: string[] } | null {
  const simple = command.replaceAll("\t", " ");
  if (!isSafeSupportCommand(simple)) return null;
  const words = simple.trim().split(/ +/);
  const program = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (program < 0) return null;
  const runner = words[program];
  const args = words.slice(program + 1);

  if (runner === "make" || runner === "gmake") {
    // A make option can suppress recipes or consume the next word as its value.
    // Recognize ordinary goals and unambiguous execution options only.
    if (words.some((word) => /^(?:GNUMAKEFLAGS|MAKEFLAGS|MFLAGS)=/.test(word))) return null;
    const goals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-C" || arg === "-f" || arg === "--directory" || arg === "--file") {
        if (!args[++i]) return null;
      } else if (/^(?:-j\d+|--jobs=\d+|-s|--silent|-k|--keep-going)$/.test(arg)) {
        continue;
      } else if (arg.startsWith("-") || arg.includes("=")) {
        return null;
      } else {
        goals.push(arg);
      }
    }
    return { runner, args: goals };
  }

  if (!["bun", "npm", "pnpm", "yarn", "pytest", "cargo", "go", "mvn", "gradle"].includes(runner)) return null;
  return { runner, args };
}
