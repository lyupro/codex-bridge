/**
 * Plan_63 D7: runner refusals and replies obtain order-input spellings from the schema, so
 * changing the input channel only changes orderInputName instead of leaving stale instructions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_ORDER_LABELS, orderInputName } from '../../src/home/lib/order-schema.mjs';

const LIB = fileURLToPath(new URL('../../src/home/lib/', import.meta.url));
const SPELLINGS = [...new Set(ALL_ORDER_LABELS.map(orderInputName))];

function scan(source, file) {
  // Keep quoted text: a flag in a string is precisely the instruction this guard must catch.
  // Mask comments without removing line breaks so diagnostics still name the original line.
  const code = source.replace(
    /'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token) => token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token,
  );
  const findings = [];
  for (const spelling of SPELLINGS) {
    const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of code.matchAll(new RegExp(`${escaped}(?![A-Za-z0-9-])`, 'g'))) {
      const line = code.slice(0, match.index).split('\n').length;
      findings.push(`${file}:${line}: ${spelling} — use orderInputName(label)`);
    }
  }
  return findings;
}

function moduleFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(file);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [file] : [];
  });
}

test('runner and meta code take every order-input spelling from the schema', () => {
  const findings = ['runner', 'meta'].flatMap((directory) =>
    moduleFiles(path.join(LIB, directory)).flatMap((file) => {
      const relative = path.relative(LIB, file).split(path.sep).join('/');
      // Plan_63 D7: args.mjs still parses flags until the input-channel switch.
      if (relative === 'runner/args.mjs') return [];
      return scan(fs.readFileSync(file, 'utf8'), `src/home/lib/${relative}`);
    }),
  );
  assert.deepEqual(findings, [], findings.join('\n'));
});

test('the scanner reports code spellings, ignores comments and respects whole flags', () => {
  const spelling = orderInputName('order id');
  assert.deepEqual(scan("// header\nconst input = '--order-id';", 'inline.mjs'), [
    `inline.mjs:2: ${spelling} — use orderInputName(label)`,
  ]);
  assert.deepEqual(scan(`// ${spelling}\n/* ${spelling}\n${spelling} */`, 'inline.mjs'), []);
  assert.deepEqual(scan(`/* ${spelling}\n*/\nconst input = '${spelling}';`, 'inline.mjs'), [
    `inline.mjs:3: ${spelling} — use orderInputName(label)`,
  ]);
  assert.deepEqual(scan(`const input = '${spelling} // still code';`, 'inline.mjs'), [
    `inline.mjs:1: ${spelling} — use orderInputName(label)`,
  ]);
  const scope = orderInputName('scope');
  const scopeNew = orderInputName('scope new');
  assert.deepEqual(scan(`'${scopeNew}'`, 'inline.mjs'), [
    `inline.mjs:1: ${scopeNew} — use orderInputName(label)`,
  ]);
  assert.deepEqual(scan(`'${scope}d' '${scope}-extra' '${scope}1' '${scope}A'`, 'inline.mjs'), []);
});
