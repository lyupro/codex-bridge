/**
 * Turns a run's artifacts on disk into values the rest of the verdict can compare.
 *
 * Two sides spell the same file differently — git prints repo-relative paths with forward
 * slashes, Codex writes whatever it likes — so nothing above this module compares a path
 * before it has been through here. This is also the only module that touches the
 * filesystem for reading: everything else receives text, JSON or a byte count from it.
 */
import fs from 'node:fs';

/** One line, no newlines, bounded length — a five-line reply must stay five lines. */
export const line = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/**
 * A run's JSON artifact, or null when there is none to read. The byte-order mark is stripped
 * first: JSON.parse rejects it, and a status.json rewritten by a Windows editor or by
 * PowerShell's `Set-Content -Encoding utf8` would then read as "no such run" — silently
 * excusing that run from every check that looks it up.
 */
export const readJson = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    // Compared by code point rather than matched by a literal: a byte-order mark in the
    // source of this file would be invisible to the next reader.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
};

export const size = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * Snapshot lines are `<added>\t<deleted>\t<path>` for tracked files and `U\t<bytes>\t<path>`
 * for untracked ones — see worktreeSnapshot() in runner/git-state.mjs. Path last, state first.
 */
export const snapshotMap = (text) => {
  const map = new Map();
  for (const row of text.split(/\r?\n/).filter(Boolean)) {
    const parts = row.split('\t');
    if (parts.length < 3) continue;
    map.set(parts.slice(2).join('\t').trim(), `${parts[0]}\t${parts[1]}`);
  }
  return map;
};

/**
 * Paths Codex actually touched, by content rather than by porcelain letter: a file that
 * was already ` M` stays ` M` after further edits, so status codes would report zero
 * work. Line counts (or size, for untracked files) do change.
 */
export const changedPaths = (before, after) => {
  const was = snapshotMap(before);
  const now = snapshotMap(after);
  const paths = [];
  for (const [file, state] of now) if (was.get(file) !== state) paths.push(file);
  // A path that dropped out was touched too: Codex restored it to its committed state.
  for (const file of was.keys()) if (!now.has(file)) paths.push(file);
  return paths;
};

/** Directories a delegated build has no business editing, whatever the task says. */
export const SERVICE_RE = /^(\.omx|\.omc|\.claude|\.codex|\.git|node_modules)\//;

/**
 * Paths arrive from two sides that spell them differently: git prints repo-relative with
 * forward slashes, while Codex writes whatever it likes — backslashes, `./` prefixes,
 * absolute paths, the occasional backtick left over from markdown.
 */
export const displayPath = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');

/** Comparison spelling: displayPath's canonical separators plus Windows-style case folding. */
export const normalizePath = (value) => displayPath(value).toLowerCase();

/** Suffix match, so an absolute path from Codex still meets a relative one from git. */
export const samePath = (declared, touched) => {
  const left = normalizePath(declared);
  const right = normalizePath(touched);
  return left === right || right.endsWith(`/${left}`) || left.endsWith(`/${right}`);
};

/**
 * One --scope pattern as a regular expression. Deliberately a small glob dialect and not a
 * dependency: `**` crosses directory boundaries, `*` and `?` stop at `/`, matching is
 * case-insensitive because Windows paths arrive in whatever case Codex felt like using.
 * A slash right after `**` is optional, so `src/**` covers `src/a.ts` too — otherwise the
 * most natural way to write a scope would silently match nothing.
 */
export function globToRegExp(pattern) {
  const glob = String(pattern ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * The paths one changes[].file entry actually names. BUILD_SCHEMA asks only for a non-empty
 * string, so Codex folds several files into one: 2026-07-31_120340 edited three real files
 * and called them `.../cost/{types,phase-cost-recorder,tier1-capture}.ts`, a string no git
 * path can ever equal. Enumerations split on `;` and `,` outside braces, braces expand one
 * level, and globs come back as patterns — `src/*.test.ts` is a claim about a set of files,
 * not a file. Nested braces are deliberately unsupported: Codex has never written one.
 */
export function expandDeclared(file) {
  const raw = String(file ?? '');
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if ((ch === ';' || ch === ',') && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const expand = (value) => {
    const brace = /\{([^{}]*)\}/.exec(value);
    if (!brace) return [value];
    const head = value.slice(0, brace.index);
    const tail = value.slice(brace.index + brace[0].length);
    return brace[1].split(',').flatMap((option) => expand(`${head}${option.trim()}${tail}`));
  };

  // Deduplication compares exact spellings, not suffixes: `a/x.mjs` and `b/a/x.mjs` declared in
  // one entry are two files, and samePath would fold the pair into one.
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    for (const candidate of expand(part)) {
      const displayed = displayPath(candidate);
      const key = normalizePath(displayed);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(displayed);
    }
  }
  return out;
}

/** A declared entry against real paths: a glob matches as a pattern, a path by suffix. */
export const declaredHits = (declared, paths) => {
  if (!/[*?]/.test(declared)) return paths.some((p) => samePath(declared, p));
  const re = globToRegExp(declared);
  return paths.some((p) => re.test(p));
};
