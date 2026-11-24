// Read literal shell words up to the first command boundary. A quoted pipe or
// semicolon stays in its argument. Dynamic shell expressions are left unknown.
function firstCommand(source: string): { words: string[]; operator: string; rest: string } | null {
  const words: string[] = [];
  let word: string | undefined;
  let redirectTarget = false;
  const token = /(?<space>[ \t]+)|(?<duplicate>\d*[<>]&\d+(?=[ \t|;&]|$))|(?<redirect>\d*(?:>>?|<))|(?<operator>&&|\|\||[|;])|'(?<single>[^']*)'|"(?<double>(?:[^"\\$`]|\\["\\])*)"|\\(?<escaped>[^\n])|(?<bare>[^\s;|&<>`$#()'"\\]+)/gy;
  while (token.lastIndex < source.length) {
    const field = token.exec(source)?.groups;
    if (!field) return null;
    if (field.space || field.operator || field.redirect || field.duplicate) {
      if (word !== undefined) {
        if (!redirectTarget) words.push(word);
        redirectTarget = false;
        word = undefined;
      }
      if (redirectTarget && !field.space) return null;
      if (field.redirect) redirectTarget = true;
      if (field.operator) return { words, operator: field.operator, rest: source.slice(token.lastIndex) };
    } else {
      word = (word ?? "") + (field.single ?? field.double?.replace(/\\(["\\])/g, "$1") ?? field.escaped ?? field.bare);
    }
  }
  if (redirectTarget && word === undefined) return null;
  if (!redirectTarget && word !== undefined) words.push(word);
  return { words, operator: "", rest: "" };
}

type Invocation = { runner: string; args: string[] };

function programName(word = ""): string {
  return word.startsWith("/") || word.startsWith("~/") ? word.slice(word.lastIndexOf("/") + 1) : word;
}

export function verificationInvocations(command: string, passed: boolean): Invocation[] {
  let part = firstCommand(command);
  if (!part) return [];
  const shell = programName(part.words[0]) === "env" ? part.words.slice(1) : part.words;
  if (["bash", "sh", "zsh"].includes(programName(shell[0])) && /^-l?c$/.test(shell[1]) && shell.length === 3) {
    part = firstCommand(shell[2]);
  }
  if (part?.words[0] === "cd" && part.words.length === 2 && part.operator === "&&") part = firstCommand(part.rest);
  const found: Invocation[] = [];
  while (part) {
    const invocation = runnerInvocation(part.words);
    if (!invocation) break;
    found.push(invocation);
    if (part.operator === ";") {
      part = firstCommand(part.rest);
    } else if (part.operator === "&&" && passed) {
      // Success proves the last command in a two-command AND list ran.
      // A later fallback or pipeline could mask a skipped invocation.
      const next = firstCommand(part.rest);
      part = next?.operator === "" ? next : null;
    } else {
      break;
    }
  }
  return found;
}

function runnerInvocation(words: string[]): Invocation | null {
  let program = 0;
  if (programName(words[program]) === "env") program++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[program])) program++;
  if (programName(words[program]) === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(words[program + 1])) program += 2;
  const runner = programName(words[program]);
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
