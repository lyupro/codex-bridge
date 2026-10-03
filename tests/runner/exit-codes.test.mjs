/**
 * Plan_60 D2b: code 4 was assigned twice when literals and unchecked docs drifted apart.
 * Keep the runner, verdict table and dispatcher instructions tied to one frozen exit-code table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const fix = 'Change the number only in exit-codes.mjs, then update';

test('EXIT contains distinct integers and is frozen', () => {
  const values = Object.values(EXIT);
  assert.ok(values.every(Number.isInteger), `${fix} its entries to distinct integers.`);
  assert.equal(new Set(values).size, values.length, `${fix} its entries to remove duplicate codes.`);
  assert.ok(Object.isFrozen(EXIT), `${fix} its declaration to freeze the exported object.`);
});

test('runner modules use EXIT instead of bare numeric exit codes', () => {
  const files = [
    'src/home/lib/runner/launcher.mjs',
    'src/home/lib/runner/attach.mjs',
    'src/home/lib/runner/args.mjs',
    'src/home/lib/runner/advise-carry.mjs',
    'src/home/lib/runner/run-env.mjs',
    'src/home/lib/write-meta.mjs',
    'src/home/lib/run-codex.mjs',
  ];
  const patterns = [
    /\breturn \d+;/g,
    /\bdie\([^)]*,\s*\d+\)/g,
    /process\.exit\(\d+\)/g,
    /exitCode\s*=\s*\d+/g,
  ];
  const offenders = [];
  for (const file of files) {
    const source = read(file);
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `${fix} runner modules to reference EXIT:\n${offenders.join('\n')}`);
});

test('the verdict status table lists every EXIT entry in order', () => {
  const file = 'docs/verdict.md';
  const source = read(file).replaceAll('\r\n', '\n');
  const heading = '## Statuses and process codes\n';
  const start = source.indexOf(heading);
  assert.notEqual(start, -1, `${fix} ${file} to restore the Statuses and process codes section.`);
  const section = source.slice(start + heading.length).split(/^## /m)[0];
  const table = section.match(/^\|[^\n]+\|(?:\n\|[^\n]+\|)+/m);
  assert.ok(table, `${fix} ${file} to restore the exit-code table.`);
  const [header, separator, ...rows] = table[0].split('\n');
  assert.equal(header.split('|')[1].trim(), 'Name', `${fix} ${file} to use the Name column header.`);
  assert.match(separator, /^\|(?:\s*:?-+:?\s*\|){3}$/, `${fix} ${file} to restore the table separator.`);
  const pairs = rows.map((row) => {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 3, `${fix} ${file} to give each table row three columns: ${row}`);
    assert.match(cells[0], /^`[A-Z]+`$/, `${fix} ${file} to use backticked EXIT names: ${row}`);
    assert.match(cells[2], /^`\d+`$/, `${fix} ${file} to use backticked integer codes: ${row}`);
    return { name: cells[0].slice(1, -1), code: Number(cells[2].slice(1, -1)) };
  });
  const expected = Object.entries(EXIT).map(([name, code]) => ({ name, code }));
  assert.deepEqual(pairs, expected, `${fix} ${file} to list every EXIT name and code in numeric order.`);
});

test('dispatcher prompts agree with the EXIT status codes and UNAVAILABLE meaning', () => {
  const expected = [EXIT.OK, EXIT.FAIL, EXIT.LIMIT, EXIT.UNAVAILABLE];
  for (const agent of ['scout', 'build', 'review', 'advisor']) {
    const file = `src/agents/codex-${agent}.md`;
    const source = read(file);
    const sequences = [...source.matchAll(/`\d+`(?: \/ `\d+`)+/g)];
    assert.equal(sequences.length, 1, `${fix} ${file} to contain exactly one slash-separated code sequence.`);
    const codes = [...sequences[0][0].matchAll(/`(\d+)`/g)].map((match) => Number(match[1]));
    assert.deepEqual(codes, expected, `${fix} ${file} to list OK / FAIL / LIMIT / UNAVAILABLE codes.`);
    const meaning = `Code \`${EXIT.UNAVAILABLE}\` means \`UNAVAILABLE\``;
    assert.ok(source.includes(meaning), `${fix} ${file} to state: ${meaning}.`);
  }
});
