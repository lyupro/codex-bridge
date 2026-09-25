/**
 * Verifies hook diagnostic writes stay registry-owned and fail-open. Plan_65 B3 consolidates two
 * direct home writes after the purge registry exposed how duplicated paths could escape ownership.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { recordHookDiagnostic } from '../src/home/lib/hook-diagnostics.mjs';
import { makeTempTree } from './temp-tree.mjs';

test('records both declared hook diagnostics as the original JSON bytes', () => {
  const root = makeTempTree('hook-diagnostics-');
  const input = { hook_event_name: 'test', tool_input: { value: 7 } };
  const expected = `${JSON.stringify(input, null, 2)}\n`;

  recordHookDiagnostic('order-gate', input, { root });
  recordHookDiagnostic('reply-guard', input, { root });

  for (const hookName of ['order-gate', 'reply-guard']) {
    const file = path.join(root, 'state', 'diagnostics', `${hookName}.last.json`);
    assert.equal(fs.readFileSync(file, 'utf8'), expected);
  }
});

test('swallows undeclared artifact names without writing anything', () => {
  const root = makeTempTree('hook-diagnostics-');

  assert.doesNotThrow(() => recordHookDiagnostic('other-hook', { value: 1 }, { root }));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('swallows filesystem errors when state is not a directory', () => {
  const root = makeTempTree('hook-diagnostics-');
  fs.writeFileSync(path.join(root, 'state'), 'regular file');

  assert.doesNotThrow(() => recordHookDiagnostic('order-gate', { value: 1 }, { root }));
});
