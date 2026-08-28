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

function addPath(paths, value) {
  const candidate = unquote(value);
  if (candidate
    && !['&', '$', '%', '`'].includes(candidate[0])
    && !IMPOSSIBLE_IN_A_NAME.test(candidate)
    && !paths.includes(candidate)) paths.push(candidate);
}

function tokens(segment) {
  return segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) ?? [];
}

// A `>` inside a quoted argument is text, not a redirect. The 2026-08-28 worktree-lock refusal
// named `#'` from `sed -E 's#(A ).*#\1<redacted>#'` because this scan previously read raw text.
function quotedCharacters(command) {
  const quoted = new Uint8Array(command.length);
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else quoted[index] = 1;
    } else if (quote === '"') {
      if (character === '\\' && index + 1 < command.length) {
        quoted[index] = 1;
        quoted[index + 1] = 1;
        index += 1;
      } else if (character === '"') quote = null;
      else quoted[index] = 1;
    } else if (character === '\\' && index + 1 < command.length) {
      index += 1;
    } else if (character === "'" || character === '"') {
      quote = character;
      quoted[index] = 1;
    }
  }
  return quote ? null : quoted;
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
      || /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9_-]+$/.test(value)) addPath(paths, value);
  }
  return { header: header[1], paths, writes: true };
}

/** Returns `{ writes, paths }` for the deliberately obvious write forms this guard recognises. */
export function shellWriteIntent(command) {
  if (typeof command !== 'string' || !command.trim()) return { writes: false, paths: [] };
  const paths = [];
  const document = heredoc(command);
  const shell = document?.header ?? command;
  let writes = document?.writes ?? false;
  const quoted = quotedCharacters(shell);

  for (const match of shell.matchAll(/(?<![<>=])(?:\d*)>>?(?![=>&])\s*("(?:\\.|[^"])*"|'[^']*'|[^\s;|&]+)/g)) {
    if (quoted && quoted[match.index]) continue;
    writes = true;
    addPath(paths, match[1]);
  }

  // A real output redirect identifies the writer's destination. Body text is only evidence when
  // the interpreter itself is the writer, as in the 2026-08-16 python heredoc incident.
  if (!paths.length && document?.writes) {
    for (const candidate of document.paths) addPath(paths, candidate);
  }

  for (const segment of shell.split(/(?:&&|\|\||[;|\r\n])/)) {
    const parts = tokens(segment);
    const index = parts.findIndex((part) => COMMANDS.has(commandName(part)));
    if (index < 0) continue;
    const name = commandName(parts[index]);
    const args = parts.slice(index + 1);
    if (name === 'sed' && !args.some((arg) => /^-.*i/.test(arg))) continue;
    writes = true;
    const values = positional(args);
    if (name === 'cp' || name === 'mv') {
      if (values.length > 1) addPath(paths, values.at(-1));
    } else if (name === 'sed') {
      for (const value of values.slice(1)) addPath(paths, value);
    } else {
      for (const value of values) addPath(paths, value);
    }
  }

  return { writes, paths };
}
