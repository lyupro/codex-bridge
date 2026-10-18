/** OW-068: advisor judge reasons keep their exact text, multiplicity and order through the catalog. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { judgeAdvice } from '../../src/home/lib/meta/advice-verdict.mjs';
import { validAdvice, validScope } from './advisor-fixtures.mjs';

const repoRoot = makeTempTree('advisor-reasons-');
fs.mkdirSync(path.join(repoRoot, 'src'));
fs.writeFileSync(path.join(repoRoot, 'src/entry.mjs'), 'first\nsecond\nthird\n');

function input(phase = 'advise') {
  return {
    phase,
    result: phase === 'advise' ? validAdvice() : validScope(),
    task: { options: [{ id: 'keep' }, { id: 'split' }, { id: 'later' }], paths: ['src'] },
    repoRoot, commandsRun: 1, language: 'English',
  };
}

// OW-068 / Plan_80 E21: literal arrays preserve multiplicity and order; the status shows only two.
test('combined advise failures retain exact reason text and order across judge passes', () => {
  const value = input();
  value.result.recommendation.text = 'Broken\u0000 recommendation; either works.';
  value.commandsRun = 0;
  value.result.recommendation.option_id = 'unknown';
  value.result.independent_checks[0].evidence = [{ file: 'src/entry.mjs', line_start: 4, line_end: 4 }];
  assert.deepEqual(judgeAdvice(value), {
    ok: false,
    reasons: [
      'integrity recommendation.text: remove control character U+0000.',
      'D4 commandsRun 0: inspect repository evidence before answering.',
      'D5 recommendation.option_id "unknown": choose a task option id.',
      'D3 independent_checks[0].evidence[0] "src/entry.mjs:4": use an ascending line range within this file\'s 3 lines.',
      'D5 recommendation.text "either works": replace backstop phrase "either works" with a decision.',
    ],
  });
});

test('combined scope failures retain exact reason text and order', () => {
  const value = input('scope');
  value.result.taken_on_trust = [];
  value.result.sufficient = false;
  value.result.predicted_risks[2].id = 'r1';
  assert.deepEqual(judgeAdvice(value), {
    ok: false,
    reasons: [
      'D4 taken_on_trust []: name at least one assumption taken on trust.',
      'D4 missing_paths [] with sufficient false: name the paths needed for advice.',
      'D10 predicted_risks[2].id "r1": use a unique predicted risk id.',
    ],
  });
});

function unlisted(description) {
  const value = input();
  value.result.recommendation.option_id = 'none-of-these';
  value.result.unlisted_option = description;
  value.result.rejected = value.task.options.map(({ id }) => ({ option_id: id, cost: 'Requires caller migration.' }));
  return value;
}

test('unlisted option rejects 39 code points and accepts 40', () => {
  assert.deepEqual(judgeAdvice(unlisted('123456789012345678901234567890123456789')), {
    ok: false,
    reasons: [
      'D10 unlisted_option "123456789012345678901234567890123456789": describe an unlisted option in at least 40 characters.',
    ],
  });
  assert.deepEqual(judgeAdvice(unlisted('1234567890123456789012345678901234567890')), { ok: true, reasons: [] });
});

test('unlisted option counts a supplementary-plane character as one code point', () => {
  assert.deepEqual(judgeAdvice(unlisted('12345678901234567890123456789012345678😀')), {
    ok: false,
    reasons: [
      'D10 unlisted_option "12345678901234567890123456789012345678😀": describe an unlisted option in at least 40 characters.',
    ],
  });
  assert.deepEqual(judgeAdvice(unlisted('123456789012345678901234567890123456789😀')), { ok: true, reasons: [] });
});

test('unlisted option ignores surrounding whitespace in its length but preserves it in the reason', () => {
  assert.deepEqual(judgeAdvice(unlisted('  123456789012345678901234567890123456789  ')), {
    ok: false,
    reasons: [
      'D10 unlisted_option "  123456789012345678901234567890123456789  ": describe an unlisted option in at least 40 characters.',
    ],
  });
  assert.deepEqual(judgeAdvice(unlisted('  1234567890123456789012345678901234567890  ')), { ok: true, reasons: [] });
});
