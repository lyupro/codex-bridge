/**
 * Turns a run's artifacts on disk into values the rest of the verdict can compare.
 *
 * Two sides spell the same file differently — git prints repo-relative paths with forward
 * slashes, Codex writes whatever it likes — so nothing above this module compares a path
 * before it has been through here. Strict snapshot judgement belongs to run-snapshots.mjs.
 */
import fs from 'node:fs';
import { readJsonFileSync } from '../json-file.mjs';
import { compareSnapshots, decodeSnapshot } from './snapshot-format.mjs';

/**
 * `slice` counts UTF-16 units and can leave half of an emoji or a rare CJK character at the cut;
 * a lone surrogate in a reply is the same kind of broken text Plan_68 D6 refuses from the model.
 */
export const safeSlice = (value, max) => {
  const text = String(value ?? '').toWellFormed();
  const result = text.slice(0, max);
  return result.isWellFormed() ? result : result.slice(0, -1);
};

/** One line, no newlines, bounded length — a five-line reply must stay five lines. */
export const line = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;

  const ellipsis = '...';
  if (max <= ellipsis.length) return safeSlice(text, Math.max(0, max));

  const contentLimit = max - ellipsis.length;
  const boundary = text.lastIndexOf(' ', contentLimit);
  // `All 298 tests pass` once became `All 29`; a reply must omit a whole word, not corrupt it.
  // Retreating to a space is the whole fix, and it is enough on its own: what survives ends
  // where a word ended. Dropping a trailing number here as well cost `All 298 12345678 rest`
  // its 298 — a number that fitted whole — because the digit test compared the limit rather
  // than the point the text was actually cut at.
  if (boundary > 0) return `${safeSlice(text, boundary)}${ellipsis}`;

  // No space to retreat to: the limit lands inside a single long word. Only here can the cut
  // land mid-number, so only here is a partial number dropped.
  return `${safeSlice(text, contentLimit).replace(/\d+$/, '')}${ellipsis}`;
};

export const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/**
 * A run's JSON artifact, or null when there is none to read. The shared reader strips the
 * byte-order mark that PowerShell's `Out-File -Encoding utf8` added in the Plan_24 incident.
 */
export const readJson = (file) => {
  try {
    return readJsonFileSync(file);
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
 * Tolerant display reader for reply, run-state and write-meta; invalid snapshots display
 * an empty Map. Strict judgement goes through run-snapshots.mjs.
 */
export const snapshotMap = (text) => {
  const snapshot = decodeSnapshot(text);
  return snapshot.ok ? snapshot.rows : new Map();
};

/**
 * Tolerant display reader for reply, run-state and write-meta; invalid comparisons display
 * no changes. Strict judgement goes through run-snapshots.mjs. Snapshot states measure
 * edits even when a file's porcelain letter stays unchanged.
 */
export const changedPaths = (before, after) => {
  const comparison = compareSnapshots(before, after);
  return comparison.ok ? comparison.changed : [];
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
 * One scope pattern as a regular expression. Deliberately a small glob dialect and not a
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
