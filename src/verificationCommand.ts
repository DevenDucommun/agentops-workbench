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
    passed = passed && part.operator === "";
    part = firstCommand(shell[2]);
  }
  const found: Invocation[] = [];
  let checkedAndList = false;
  while (part) {
    const invocation = runnerInvocation(part.words);
    if (invocation) found.push(invocation);
    else if (!isSetupCommand(part.words)) break;

    if (part.operator === "&&") {
      if (!passed) break;
      if (!checkedAndList && !endsWithAndList(part.rest)) break;
      checkedAndList = true;
    } else if (part.operator !== ";") {
      break;
    }
    part = firstCommand(part.rest);
  }
  return found;
}

// A zero exit proves that every pipeline in a literal AND list was entered.
// Whether its last program is itself a verifier is immaterial. A fallback
// or a later independent command can supply that exit status instead.
function endsWithAndList(source: string): boolean {
  let part = firstCommand(source);
  while (part && part.words.length > 0) {
    if (part.operator !== "&&" && part.operator !== "|") {
      return part.operator === "" || (part.operator === ";" && part.rest.trim() === "");
    }
    part = firstCommand(part.rest);
  }
  return false;
}

function isSetupCommand(words: string[]): boolean {
  const [program, arg] = words;
  if (program === "cd") return words.length === 2;
  if (program === "set") return words.length === 2 && arg === "-e";
  if (program === "export") return words.length === 2 && /^CI=[A-Za-z0-9_-]+$/.test(arg);
  return programName(program) === "git" && arg === "status";
}

function runnerInvocation(words: string[]): Invocation | null {
  let program = 0;
  if (programName(words[program]) === "env") program++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[program])) program++;
  if (programName(words[program]) === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(words[program + 1])) program += 2;
  if (words[program] === "time") program++;
  const launcher = programName(words[program]);
  if (/^python(?:3(?:\.\d+)?)?$/.test(launcher) && words[program + 1] === "-m" && words[program + 2] === "pytest") program += 2;
  if (["uv", "poetry"].includes(launcher) && words[program + 1] === "run" && words[program + 2] === "pytest") program += 2;
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
