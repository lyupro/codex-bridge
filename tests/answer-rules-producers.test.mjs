/** OW-068: every advisor failure reason is produced through the answer-rules catalog, never by hand. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RULES } from '../src/home/lib/answer-rules/advisor.mjs';

const source = fs.readFileSync(new URL('../src/home/lib/meta/advice-verdict.mjs', import.meta.url), 'utf8');
const catalogKeys = Object.keys(RULES);

// OW-068 / Plan_80 E21: future failure branches must use the same catalog as the prompt.
function producerProblems(source, catalogKeys) {
  const problems = [];
  const known = new Set(catalogKeys);
  const produced = new Set();
  for (const match of source.matchAll(/\breason\s*\(\s*(['"])([^'"]+)\1|\bkey\s*:\s*(['"])([^'"]+)\3/g)) {
    const key = match[2] ?? match[4];
    if (!known.has(key)) problems.push(`unknown catalog key: ${key}`);
    produced.add(key);
  }
  for (const key of known) {
    if (!produced.has(key)) problems.push(`missing producer: ${key}`);
  }

  for (const match of source.matchAll(/\breasons\s*\.\s*push\s*\(/g)) {
    const args = [];
    let start = match.index + match[0].length;
    let depth = 0;
    let quote = null;
    let closed = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if ('([{'.includes(char)) depth += 1;
      else if (char === ')' && depth === 0) {
        args.push(source.slice(start, index).trim());
        closed = true;
        break;
      } else if (')]}'.includes(char)) depth -= 1;
      else if (char === ',' && depth === 0) {
        args.push(source.slice(start, index).trim());
        start = index + 1;
      }
    }
    if (!closed) problems.push('unclosed reasons.push');
    for (const arg of args) {
      // The citation dispatcher is the sole dynamic key: citationProblem returns catalog literals.
      const citationDispatch = /^reason\(problem\.key,\s*\{\s*field,\s*label,\s*\.\.\.problem\.values\s*\}\s*\)$/;
      if (!/^reason\('[^']+'(?=\s*[,\)])/.test(arg) && !citationDispatch.test(arg)) {
        problems.push(`reasons.push bypasses catalog: ${arg}`);
      }
    }
  }
  if (/['"`](?:D3|D4|D5|D10|integrity) /.test(source)) problems.push('handwritten failure reason');
  const returns = [...source.matchAll(/\breturn\s*\{\s*ok\s*:/g)].length;
  if (returns !== 1) problems.push(`expected one verdict return, found ${returns}`);
  return problems;
}

function mutated(before, after) {
  assert.ok(source.includes(before), `mutation anchor missing: ${before}`);
  return source.replace(before, after);
}

test('advisor judge produces every catalog rule and every reason goes through the catalog', () => {
  assert.deepEqual(producerProblems(source, catalogKeys), []);
});

test('producer guard rejects unknown literal emitter and citation keys', () => {
  for (const key of ['advisor-commands-run', 'advisor-citation-path']) {
    const edited = mutated(`'${key}'`, "'advisor-unknown'");
    assert.ok(producerProblems(edited, catalogKeys).includes('unknown catalog key: advisor-unknown'));
  }
});

test('producer guard rejects a handwritten reason added to the real judge', () => {
  const edited = mutated('const reasons = [];', 'const reasons = []; reasons.push(`D5 x`);');
  const problems = producerProblems(edited, catalogKeys);
  assert.ok(problems.some((problem) => problem.startsWith('reasons.push bypasses catalog:')));
  assert.ok(problems.includes('handwritten failure reason'));
});

test('producer guard checks every push argument and disallows arbitrary dynamic keys', () => {
  for (const extra of ["'unlisted failure'", 'reason(other.key, {})']) {
    const edited = mutated("reason('advisor-commands-run'))", `reason('advisor-commands-run'), ${extra})`);
    assert.ok(producerProblems(edited, catalogKeys).some((problem) => problem.startsWith('reasons.push bypasses catalog:')));
  }
});

test('producer guard rejects a second verdict return', () => {
  const edited = mutated('const reasons = [];', 'const reasons = []; return { ok: false, reasons };');
  assert.ok(producerProblems(edited, catalogKeys).includes('expected one verdict return, found 2'));
});

test('producer guard rejects a catalog rule removed from the judge', () => {
  const edited = mutated("reasons.push(reason('advisor-commands-run'));", ';');
  assert.ok(producerProblems(edited, catalogKeys).includes('missing producer: advisor-commands-run'));
});
