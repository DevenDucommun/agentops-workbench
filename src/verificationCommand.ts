// Read literal shell words up to the first command boundary. A quoted pipe or
// semicolon stays in its argument. Dynamic shell expressions are left unknown.
function firstCommand(source: string): { words: string[]; operator: string; rest: string } | null {
  const words: string[] = [];
  let word: string | undefined;
  const token = /(?<space>[ \t]+)|(?<redirect>2>&1(?=[ \t|;&]|$))|(?<operator>&&|\|\||[|;])|'(?<single>[^']*)'|"(?<double>(?:[^"\\$`]|\\["\\])*)"|\\(?<escaped>[^\n])|(?<bare>[^\s;|&<>`$#()'"\\]+)/gy;
  while (token.lastIndex < source.length) {
    const field = token.exec(source)?.groups;
    if (!field) return null;
    if (field.space || field.operator || field.redirect) {
      if (word !== undefined) words.push(word);
      word = undefined;
      if (field.operator) return { words, operator: field.operator, rest: source.slice(token.lastIndex) };
    } else {
      word = (word ?? "") + (field.single ?? field.double?.replace(/\\(["\\])/g, "$1") ?? field.escaped ?? field.bare);
    }
  }
  if (word !== undefined) words.push(word);
  return { words, operator: "", rest: "" };
}

export function verificationInvocation(command: string): { runner: string; args: string[] } | null {
  let part = firstCommand(command);
  if (!part) return null;
  // Codex records the login shell and its literal -c argument as the command.
  if (/^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)$/.test(part.words[0]) && /^-l?c$/.test(part.words[1]) && part.words.length === 3) {
    part = firstCommand(part.words[2]);
  }
  // Recognize the common working-directory prefix. Other conditional branches
  // can be skipped by the shell, so they do not identify an observed runner.
  if (part?.words[0] === "cd" && part.words.length === 2 && part.operator === "&&") part = firstCommand(part.rest);
  if (!part) return null;
  const words = part.words;
  let program = 0;
  if (words[program] === "env") program++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[program])) program++;
  if (words[program] === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(words[program + 1])) program += 2;
  const runner = words[program];
  const args = words.slice(program + 1);
  if (args.some(arg => ["-h", "--help", "-V", "--version", "--dry-run", "--list", "--collect-only"].includes(arg))) return null;

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
