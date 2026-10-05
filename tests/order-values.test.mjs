/** Plan_63 D9: the value grammar stays shared when the call registry is retired. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlaceholder, isInputPlaceholder, isAbsoluteTaskFilePath, splitGrantValue,
} from '../src/home/lib/order-values.mjs';

test('template placeholders remain missing after trimming, unquoting and punctuation', () => {
  for (const value of [null, undefined, 42, {}, '', '  ', '<order id from the orchestrator>',
    'TODO', 'tbd', 'LABEL', 'none', 'order id', 'scope', 'xxx', ' TODO.,;: ',
    '`TODO`', "' TBD '", '"scope"']) {
    assert.equal(isPlaceholder(value), true, String(value));
  }
  for (const value of ['plan-13-build-20260804', 'src/**', 'advise', 'high', 'none left',
    '<unfinished', 'unfinished>', '"real order"']) {
    assert.equal(isPlaceholder(value), false, value);
  }
});

test('scope and advise are real phases without weakening existing placeholders', () => {
  for (const phase of ['scope', 'advise', ' scope ', '`scope`']) {
    assert.equal(isInputPlaceholder(phase, 'phase'), false, phase);
  }
  for (const value of ['', 'TODO', '<phase>']) {
    assert.equal(isInputPlaceholder(value, 'phase'), true, value);
  }
  assert.equal(isInputPlaceholder('scope', 'scope'), true);
  assert.equal(isInputPlaceholder('SCOPE', 'phase'), true);
});

test('none is a real effort only, including cleaned values', () => {
  for (const value of ['none', ' none ', '`none`', '"none"']) {
    assert.equal(isInputPlaceholder(value, 'effort'), false, value);
    assert.equal(isPlaceholder(value), true, value);
  }
  for (const label of ['phase', 'order id', 'scope', 'continue', 'retry', '__proto__', 'constructor']) {
    assert.equal(isInputPlaceholder('none', label), true, label);
  }
  for (const value of ['NONE', 'none.', 'TODO', '']) {
    assert.equal(isInputPlaceholder(value, 'effort'), true, value);
  }
});

test('task-file values accept Windows and POSIX absolute paths but reject relative values', () => {
  for (const value of ['C:/scratch/task.md', 'C:\\scratch\\task.md', '/tmp/task.md',
    '\\\\server\\share\\task.md', '"C:/scratch/task file.md"', ' `/tmp/task.md` ']) {
    assert.equal(isAbsoluteTaskFilePath(value), true, value);
  }
  for (const value of [null, undefined, '', 'task.md', './task.md', '../task.md', 'C:task.md']) {
    assert.equal(isAbsoluteTaskFilePath(value), false, String(value));
  }
});

test('continuation grant values parse with the accepted separators', () => {
  const run = '2026-08-05_092913_plan14-build';
  const reason = 'LIMIT at step 3, tests unwritten';
  for (const separator of [' — ', ' - ', ': ']) {
    assert.deepEqual(splitGrantValue(`${run}${separator}${reason}`), { run, reason });
  }
});

test('continuation grant values reject placeholders and incomplete values', () => {
  const run = '2026-08-05_092913_plan14-build';
  for (const value of ['', 'TODO', '<run> — reason', `${run} — TODO`, run,
    `${run} — <reason>`, `${run} —`]) {
    assert.equal(splitGrantValue(value), null, value);
  }
});

test('splitGrantValue preserves the old separators, precedence and placeholder rejection', () => {
  const run = '2026-08-05_092913_plan14-build';
  const reason = 'LIMIT at step 3, tests unwritten';
  for (const separator of [' — ', ' - ', ': ', ':', '\t—\t', '  -  ']) {
    assert.deepEqual(splitGrantValue(`${run}${separator}${reason}`), { run, reason });
  }
  assert.deepEqual(splitGrantValue('X: detail - earlier — final'), {
    run: 'X: detail - earlier', reason: 'final',
  });
  assert.deepEqual(splitGrantValue('X: detail - final'), {
    run: 'X: detail', reason: 'final',
  });
  assert.deepEqual(splitGrantValue(' `X` — " why " '), { run: 'X', reason: 'why' });
  for (const value of [null, undefined, '', 'TODO', '<run> — reason', `${run} — TODO`,
    `${run} — <reason>`, `${run} —`, run, 'none: reason', 'X: scope']) {
    assert.equal(splitGrantValue(value), null, String(value));
  }
});
