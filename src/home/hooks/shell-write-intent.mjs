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

function addPath(paths, value) {
  const candidate = unquote(value);
  if (candidate && !candidate.startsWith('&') && !paths.includes(candidate)) paths.push(candidate);
}

function tokens(segment) {
  return segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) ?? [];
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

function heredocPaths(command, paths) {
  const header = command.match(/^(.*?<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2[^\r\n]*)[\r\n]/s);
  if (!header || !INTERPRETERS.test(header[1])) return false;
  const marker = header[3];
  const body = command.slice(header[0].length).split(/\r?\n/);
  const end = body.findIndex((line) => line.trim() === marker);
  const source = body.slice(0, end < 0 ? body.length : end).join('\n');
  for (const match of source.matchAll(/(['"])(.*?)\1/g)) {
    const value = match[2];
    if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/])/.test(value)
      || /[\\/]/.test(value)
      || /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9_-]+$/.test(value)) addPath(paths, value);
  }
  return true;
}

/** Returns `{ writes, paths }` for the deliberately obvious write forms this guard recognises. */
export function shellWriteIntent(command) {
  if (typeof command !== 'string' || !command.trim()) return { writes: false, paths: [] };
  const paths = [];
  let writes = heredocPaths(command, paths);

  for (const match of command.matchAll(/(?<![<>=])(?:\d*)>>?(?![=>&])\s*("(?:\\.|[^"])*"|'[^']*'|[^\s;|&]+)/g)) {
    writes = true;
    addPath(paths, match[1]);
  }

  for (const segment of command.split(/(?:&&|\|\||[;|\r\n])/)) {
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
