/** Verifies plain table sizing, start truncation, and fixed numeric columns. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTable, truncateStart } from '../../cli/table.mjs';

test('start truncation keeps the right side of a long name', () => {
  assert.equal(truncateStart('2026-08-06_090000_long-project-name', 12), '…roject-name');
});

test('long names shrink while numbers and dates remain complete', () => {
  const output = renderTable([
    { key: 'run', header: 'run', truncate: 'start' },
    { key: 'tokens', header: 'tokens', kind: 'number' },
    { key: 'lastRun', header: 'last run timestamp', kind: 'date' },
  ], [{
    run: '2026-08-06_090000_long-project-name',
    tokens: 123456789,
    lastRun: '2026-08-06T09:00:00.000Z',
  }], { width: 40 });

  assert.match(output, /…name/);
  assert.match(output, /123456789/);
  assert.match(output, /2026-08-06T09:00:00\.000Z/);
  assert.doesNotMatch(output, /[┌┐└┘├┤┬┴┼─│]/);
});
