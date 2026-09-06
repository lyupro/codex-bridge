/**
 * Refuses the word "mode" as a name anywhere in the package's own source.
 *
 * The word meant six different things at once: which agent runs, what a review covers, how the
 * package was installed, how a prune removes runs, which side a table truncates, and how the size
 * gate reacts. Reading any one of them meant first working out which "mode" this file meant.
 * Plan_56 D10, D17 and D20 gave each its own name; this gate keeps them apart.
 *
 * The rule is deliberately one sentence with no exclusion list (D11): the word may appear in text
 * a human reads — a comment, a message, a value on disk — but never as a name the code uses. That
 * is why the installation record still spells its field `mode` on three hosts while no module here
 * writes the word: cli/install-record.mjs holds the spelling in a constant and everyone goes
 * through it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Same two directories the copied-role-list gate walks: the package's own source. Nothing outside
// this repository is in scope, and neither are tests, which build fixtures of foreign file formats.
const SCANNED = ['src', 'cli'];

function sourceFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith('.mjs') ? [full] : [];
  });
}

/**
 * Blank out every comment and quoted string, keeping the file's length and line breaks.
 *
 * What survives is the code itself, so a single search for the bare word answers the question
 * without a list of allowed spellings. Template literals keep their `${...}` holes, because a name
 * interpolated there is still a name; only their literal text is blanked.
 */
export function codeWithoutTextAndComments(source) {
  const out = Array.from(source);
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      blank(index, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end;
    } else if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (character === "'" || character === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== character) {
        cursor += source[cursor] === '\\' ? 2 : 1;
      }
      blank(index, Math.min(cursor + 1, source.length));
      index = cursor + 1;
    } else if (character === '`') {
      let cursor = index + 1;
      let textFrom = cursor;
      while (cursor < source.length && source[cursor] !== '`') {
        if (source[cursor] === '\\') {
          cursor += 2;
        } else if (source[cursor] === '$' && source[cursor + 1] === '{') {
          blank(textFrom, cursor);
          let depth = 1;
          cursor += 2;
          while (cursor < source.length && depth > 0) {
            if (source[cursor] === '{') depth += 1;
            else if (source[cursor] === '}') depth -= 1;
            cursor += 1;
          }
          textFrom = cursor;
        } else {
          cursor += 1;
        }
      }
      blank(textFrom, cursor);
      index = cursor + 1;
    } else {
      index += 1;
    }
  }
  return out.join('');
}

const WORD = /\bmode\b/i;

function offenders() {
  const found = [];
  for (const directory of SCANNED) {
    for (const file of sourceFiles(path.join(root, directory))) {
      const code = codeWithoutTextAndComments(fs.readFileSync(file, 'utf8'));
      code.split(/\r?\n/).forEach((line, number) => {
        if (WORD.test(line)) {
          found.push(`${path.relative(root, file).replaceAll('\\', '/')}:${number + 1}`);
        }
      });
    }
  }
  return found;
}

test('the word "mode" names nothing in the package source', () => {
  assert.deepEqual(
    offenders(),
    [],
    'The word "mode" meant six things at once. Give the new one its own name: '
      + 'the agent has a role, a review has a changeset, a prune has a strategy, a column has a '
      + 'truncation. A field of a file already on disk keeps its spelling in one constant instead '
      + `(see cli/install-record.mjs). Offenders: ${offenders().join(', ')}`,
  );
});

// A gate that cannot fail is decoration. These fix what the scan counts as a name and what it
// leaves alone, so a later "simplification" of the stripper cannot quietly retire the rule.
test('the scan reads names as names and text as text', () => {
  const named = [
    'const mode = 1;',
    'let mode;',
    'function f(mode) {}',
    'const { mode } = record;',
    'return record.mode;',
    'write({ mode: "copy" });',
    'const label = `${mode}`;',
  ];
  for (const line of named) {
    assert.ok(WORD.test(codeWithoutTextAndComments(line)), `should be a name: ${line}`);
  }

  const text = [
    "export const INSTALL_METHOD_KEY = 'mode';",
    '// the default mode applies when nothing is configured',
    '/* which mode a run picked */',
    'die("unknown flag: --mode; use --changeset instead");',
    'const message = `installation record mode must be copy`;',
  ];
  for (const line of text) {
    assert.ok(!WORD.test(codeWithoutTextAndComments(line)), `should be text: ${line}`);
  }
});
