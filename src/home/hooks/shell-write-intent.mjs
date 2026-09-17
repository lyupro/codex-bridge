/**
 * Reports whether a shell command plainly intends to write files and the target paths it names.
 *
 * This is deliberately not a complete list, and it cannot become one. Enumerating every way a
 * shell can write would reproduce the original defect one level up: the 2026-08-16 incident is
 * why the worktree witness hook exists beside this cheap prevention check.
 */

const COMMANDS = new Set(['cp', 'mv', 'rm', 'touch', 'truncate', 'tee', 'sed']);
const INTERPRETERS = /\b(?:python(?:\d+(?:\.\d+)?)?|node|perl|ruby)(?:\.exe)?\b/i;

function unquote(value) {
  const trimmed = value.trim().replace(/[;,]+$/, '');
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// A candidate holding a character no file name may contain is not a file name. The redirection
// pattern cannot tell `>` the operator from `>` the redirect, so `node -e "i>0?'yes':'no'"` was
// refused on 2026-08-23 naming the path `0?'yes` — a false refusal on a command that writes
// nothing. Narrowing here costs nothing the witness does not already cover.
const IMPOSSIBLE_IN_A_NAME = /[?*<>|"]/;

function addPath(paths, candidate) {
  // D4c: word values are already unquoted; raw redirects keep their separate unquote() call.
  if (candidate
    && !['&', '$', '%', '`'].includes(candidate[0])
    && !IMPOSSIBLE_IN_A_NAME.test(candidate)
    && !paths.includes(candidate)) paths.push(candidate);
}

// One quote reader owns redirects, command boundaries and words: the 2026-09-16 awk refusal
// repeated the 2026-08-23 node, 2026-08-28 sed and 2026-09-06 heredoc text-as-shell incidents.
function lexShell(command) {
  const literal = new Uint8Array(command.length);
  const state = () => ({ commands: [], words: [], word: '', started: false, escaped: false, previousLiteral: false });
  let parsed = state();
  const plain = state();
  const stack = [];
  let quote = null;
  let doubleEscape = false;
  let comment = false;

  function finish(current, endCommand) {
    if (current.word || (current !== plain && current.started)) {
      current.words.push(current.word);
      current.word = '';
      current.started = false;
    }
    if (endCommand && current.words.length) {
      current.commands.push(current.words);
      current.words = [];
    }
  }

  function append(current, index, isLiteral) {
    const character = command[index];
    if (current.escaped) {
      current.escaped = false;
      isLiteral = true;
    } else if (!isLiteral && character === '\\'
      && (/[;|&<>() \t'"\\]/.test(command[index + 1] ?? '')
        || (current !== plain && /[#$]/.test(command[index + 1] ?? '')))) {
      // Windows paths use backslashes too: Git Bash escapes shell metacharacters here,
      // but consuming every backslash would corrupt C:\tools\sed.exe and its targets.
      current.escaped = true;
      current.previousLiteral = true;
      current.started = true;
      return true;
    }
    const pipeAmpersand = character === '&' && !current.previousLiteral && command[index - 1] === '|';
    const operatorAmpersand = character === '&'
      && ((!current.previousLiteral && /[<>|]/.test(command[index - 1] ?? ''))
        || command[index + 1] === '>');
    current.previousLiteral = isLiteral;
    if (!isLiteral && pipeAmpersand) return false;
    if (!isLiteral && (';|()\r\n'.includes(character)
      || (character === '&' && !operatorAmpersand))) finish(current, true);
    else if (!isLiteral && /\s/.test(character)) finish(current, false);
    else {
      current.word += character;
      current.started = true;
    }
    return isLiteral;
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    // Keep the original quote-blind fallback for malformed input (D4c review).
    append(plain, index, false);
    if (comment) {
      if (!'\r\n'.includes(character)) {
        literal[index] = 1;
        continue;
      }
      comment = false;
    }
    let isLiteral = quote !== null || parsed.escaped || doubleEscape;
    let quoteBoundary = false;
    if (doubleEscape) doubleEscape = false;
    else if (!parsed.escaped) {
      if (quote === '"' && character === '\\' && index + 1 < command.length) {
        doubleEscape = true;
      } else if (quote) {
        if (character === quote) {
          quote = null;
          quoteBoundary = true;
        }
      } else if (character === "'" || character === '"') {
        quote = character;
        isLiteral = true;
        quoteBoundary = true;
      }
    }
    // D4c: quote fragments belong to one word; their delimiters are not its value.
    if (quoteBoundary) {
      parsed.started = true;
      parsed.previousLiteral = true;
      literal[index] = 1;
      continue;
    }
    if (!isLiteral && character === '#' && !parsed.started) {
      comment = true;
      literal[index] = 1;
      continue;
    }
    if (!isLiteral && character === '(') {
      const substitution = command[index - 1] === '$' && !parsed.previousLiteral;
      if (!parsed.started || substitution) {
        // D4c: suspend the outer command, retaining an unresolved $() in its word.
        // Flattening parentheses made a substitution suffix look like a new command.
        if (substitution) parsed.word += '()';
        stack.push(parsed);
        parsed = { ...state(), commands: parsed.commands };
        continue;
      }
      isLiteral = true;
    }
    if (!isLiteral && character === ')') {
      if (stack.length) {
        finish(parsed, true);
        parsed = stack.pop();
        parsed.previousLiteral = false;
        continue;
      }
      isLiteral = true;
    }
    literal[index] = append(parsed, index, isLiteral);
  }
  finish(parsed, true);
  while (stack.length) {
    parsed = stack.pop();
    finish(parsed, true);
  }
  finish(plain, true);
  return { literal: quote ? null : literal, commands: quote ? plain.commands : parsed.commands };
}

function positional(args) {
  return args.filter((arg) => !arg.startsWith('-'));
}

/**
 * Strip the directory and the Windows executable suffix before matching the command name.
 * `INTERPRETERS` has always allowed `python.exe`; the command list did not, so `sed.exe -i` —
 * the spelling Git Bash and PowerShell hand over on this platform — walked past the guard while
 * the identical `sed -i` was refused (found accepting the 2026-08-17 smoke run, which had recorded
 * that gap as intended behaviour).
 */
function commandName(token) {
  return token.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
}

const COMMAND_PREFIXES = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time']);
const LAUNCHERS = new Set(['xargs', 'env', 'nohup', 'timeout', 'nice', 'command', 'exec', 'sudo']);

// Plan_57 D11: `git log --grep rm` and `grep -rn touch` were refused because arguments became
// commands. These launchers only move command position; unknown launchers leave a lock gap
// covered after execution by worktree-witness.mjs, without falsely refusing a read.
function* writingCommands(parts) {
  // D4c review: 6000 nested find actions overflowed recursive yield*. Index ranges and
  // precomputed terminators keep traversal iterative without repeatedly copying/scanning tails.
  const terminators = new Array(parts.length);
  let next = parts.length;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if ([';', '+'].includes(parts[index])) next = index;
    terminators[index] = next;
  }
  const pending = [{ start: 0, end: parts.length }];
  while (pending.length) {
    const { start, end } = pending.pop();
    let launched = false;
    for (let index = start; index < end; index += 1) {
      const part = parts[index];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part) || COMMAND_PREFIXES.has(part)) continue;
      // A case pattern (`a)`, `*)`) precedes a command position the way `then` does. The lexer keeps
      // an unmatched `)` literal because `echo ) rm x` runs nothing, which alone hid
      // `case x in a) rm b.txt;; esac` — a write the scanner caught before D4c.
      if (part === 'case') {
        while (index + 1 < end && !parts[index].endsWith(')')) index += 1;
        continue;
      }
      if (part.endsWith(')')) continue;
      if (/^(?:\d*[<>]|&>)/.test(part)) {
        if (/^(?:\d*[<>]+&?|&>>?)$/.test(part)) index += 1;
        continue;
      }
      if (launched && (part.startsWith('-') || /^\d+[smhd]?$/.test(part))) {
        if (launched === 'command' && /^-[^-]*[vV]/.test(part)) break;
        continue;
      }
      const name = commandName(part);
      if (LAUNCHERS.has(name)) {
        launched = name;
        continue;
      }
      if (COMMANDS.has(name)) yield parts.slice(index, end);
      else if (name === 'find') {
        const actions = [];
        for (index += 1; index < end; index += 1) {
          if (!['-exec', '-execdir', '-ok', '-okdir'].includes(parts[index])) continue;
          const actionStart = index + 1;
          index = Math.min(terminators[actionStart] ?? end, end);
          // D11: terminators and later predicates are not action arguments.
          actions.push({ start: actionStart, end: index });
        }
        for (let action = actions.length - 1; action >= 0; action -= 1) pending.push(actions[action]);
      }
      break;
    }
  }
}

/**
 * Split a heredoc command into the shell around it and the document inside it.
 *
 * `shell` is everything the shell itself runs — the line opening the document AND every command
 * after its closing marker. Dropping that tail hid `… <<EOF … EOF; echo x >> README.md` from the
 * guard completely, and a live probe on 2026-08-23 wrote to a tracked file during a held run
 * exactly that way. `paths` holds only what the document body names, which the caller uses just
 * when the interpreter is itself the writer.
 */
function heredoc(command) {
  const header = command.match(/^(.*?<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2[^\r\n]*)[\r\n]/s);
  if (!header) return null;
  const paths = [];
  const marker = header[3];
  const body = command.slice(header[0].length).split(/\r?\n/);
  const end = body.findIndex((line) => line.trim() === marker);
  const shell = [header[1], ...(end < 0 ? [] : body.slice(end + 1))].join('\n');
  if (!INTERPRETERS.test(header[1])) return { shell, paths, writes: false };
  const source = body.slice(0, end < 0 ? body.length : end).join('\n');
  for (const match of source.matchAll(/(['"])(.*?)\1/g)) {
    const value = match[2];
    if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/])/.test(value)
      || /[\\/]/.test(value)
      || /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9_-]+$/.test(value)) addPath(paths, unquote(value));
  }
  return { shell, paths, writes: true };
}

/** Returns `{ writes, paths }` for the deliberately obvious write forms this guard recognises. */
export function shellWriteIntent(command) {
  if (typeof command !== 'string' || !command.trim()) return { writes: false, paths: [] };
  const paths = [];
  const document = heredoc(command);
  // The document body is prose until an interpreter makes it code. Reading `header` here while
  // heredoc() returned `shell` meant the whole command, body included, went through shell parsing
  // whenever the writer was plain `cat`: on 2026-09-06 the lock refused four harmless commands,
  // the last of them because a sentence in a task file said "Do not touch the installer" and
  // `touch` is in COMMANDS, so every following word became a write target under the repository.
  const shell = document?.shell ?? command;
  let writes = document?.writes ?? false;
  const { literal, commands } = lexShell(shell);

  const redirects = /(?<![<=])(?:\d*)>>?(?![=>&])\s*("(?:\\.|[^"])*"|'[^']*'|[^\s;|&]+)/g;
  let match;
  while ((match = redirects.exec(shell))) {
    if (literal?.[match.index]
      || (shell[match.index - 1] === '>' && !literal?.[match.index - 1])) {
      // D4c: a literal > must not consume the real redirect immediately after it.
      redirects.lastIndex = match.index + 1;
      continue;
    }
    writes = true;
    addPath(paths, unquote(match[1]));
  }

  // A real output redirect identifies the writer's destination. Body text is only evidence when
  // the interpreter itself is the writer, as in the 2026-08-16 python heredoc incident.
  if (!paths.length && document?.writes) {
    for (const candidate of document.paths) addPath(paths, unquote(candidate));
  }

  for (const parts of commands) {
    // D11 keeps the pre-position fallback: an unfinished quote makes word positions untrusted.
    const candidates = literal ? writingCommands(parts) : [parts];
    for (const candidate of candidates) {
      const index = literal ? 0 : candidate.findIndex((part) => COMMANDS.has(commandName(part)));
      if (index < 0) continue;
      const name = commandName(candidate[index]);
      const args = candidate.slice(index + 1);
      if (name === 'sed' && !args.some((arg) => /^-.*i/.test(arg))) continue;
      writes = true;
      const values = positional(args).map((value) => literal ? value : unquote(value));
      if (name === 'cp' || name === 'mv') {
        if (values.length > 1) addPath(paths, values.at(-1));
      } else if (name === 'sed') {
        for (const value of values.slice(1)) addPath(paths, value);
      } else {
        for (const value of values) addPath(paths, value);
      }
    }
  }

  return { writes, paths };
}
