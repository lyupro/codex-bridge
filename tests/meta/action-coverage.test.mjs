/** OW-075 A5: exit codes, next-action texts and producers must grow together. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { NEXT_ACTION_VARIANTS } from '../../src/home/lib/order-diagnostics/next-action.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { AGENTS, exitCodeFor, renderReply } from '../../src/home/lib/write-meta.mjs';
import { lex } from '../order-guard/lexer.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

const actionsByExit = {
  FAIL: ['fail-result', 'fail-no-result', 'runner-fault', 'run-in-progress',
    'runs-root-retired', 'availability-unconfirmed', 'readiness-unconfirmed',
    'advisor-scope-result', 'grant-decision', 'usage'],
  USAGE: ['usage', 'restart-window', 'grant-decision', 'repository-detached', 'sandbox-dead'],
  LIMIT: ['limit'],
  PENDING: ['pending', 'pending-no-run'],
  UNAVAILABLE: ['unavailable'],
  CAPACITY: ['capacity'],
};

test('every non-OK EXIT has known next actions and no next-action variant is orphaned', () => {
  assert.ok(Object.isFrozen(NEXT_ACTION_VARIANTS));
  assert.equal(new Set(NEXT_ACTION_VARIANTS).size, NEXT_ACTION_VARIANTS.length);
  assert.deepEqual(Object.keys(actionsByExit).sort(), Object.keys(EXIT).filter((key) => key !== 'OK').sort());
  for (const [exit, variants] of Object.entries(actionsByExit)) {
    assert.ok(variants.length > 0, `${exit} needs at least one next action`);
    for (const variant of variants) {
      assert.ok(NEXT_ACTION_VARIANTS.includes(variant), `${exit} names unknown variant ${variant}`);
    }
  }
  assert.deepEqual([...new Set(Object.values(actionsByExit).flat())].sort(), [...NEXT_ACTION_VARIANTS].sort());
});

test('every next-action variant has a producer string literal outside its registry', () => {
  const roots = ['lib', 'hooks'].map((dir) => fileURLToPath(new URL(`../../src/home/${dir}/`, import.meta.url)));
  const registry = path.join(roots[0], 'order-diagnostics', 'next-action.mjs');
  const used = new Set();
  const files = roots.flatMap((root) => fs.readdirSync(root, { recursive: true }).map((file) => path.join(root, file)));
  for (const fullPath of files) {
    if (!fullPath.endsWith('.mjs') || fullPath === registry) continue;
    const { tokens } = lex(fs.readFileSync(fullPath, 'utf8'));
    for (const token of tokens) {
      // preflight.mjs records availability.action before the launcher passes it to die().
      if (token.literal && /^(['"])[a-z][a-z-]*\1$/.test(token.value)) {
        used.add(token.value.slice(1, -1));
      }
    }
  }
  for (const variant of NEXT_ACTION_VARIANTS) {
    assert.ok(used.has(variant), `next-action ${variant} has no producer literal`);
  }
});

for (const agent of Object.keys(AGENTS)) {
  for (const [status, resultOk, variant] of [
    ['LIMIT', false, 'limit'],
    ['UNAVAILABLE', false, 'unavailable'],
    ['CAPACITY', false, 'capacity'],
    ['FAIL', true, 'fail-result'],
    ['FAIL', false, 'fail-no-result'],
  ]) {
    test(`renderReply ${agent} ${status} result_ok=${resultOk} has exactly one standalone Action row`, () => {
      const runDir = makeRun({ file: AGENTS[agent].result, ...(resultOk ? { result: buildResult([]) } : {}) });
      const reply = renderReply(runDir, agent, {
        status, result_ok: resultOk, reason: 'synthetic outcome',
        events_bytes: 0, stderr_bytes: 0, exit: 1,
      });
      assert.deepEqual(reply.split('\n').filter((row) => row.startsWith('Action:')), [
        orderDiagnosticMessage('next-action', { variant }),
      ]);
    });
  }
}

test('renderReply OK has no Action row and exitCodeFor preserves all five known statuses', () => {
  const runDir = makeRun({ result: buildResult([]) });
  const reply = renderReply(runDir, 'codex-build', { status: 'OK' });
  assert.deepEqual(reply.split('\n').filter((row) => row.startsWith('Action:')), []);
  for (const status of ['OK', 'FAIL', 'LIMIT', 'UNAVAILABLE', 'CAPACITY']) {
    assert.equal(exitCodeFor(status), EXIT[status]);
  }
});

test('unknown statuses throw while absent recorded status still exits FAIL', () => {
  const runDir = makeRun();
  for (const status of ['BOGUS', '', 'toString', '__proto__', 0, false, {}, ['FAIL']]) {
    const expected = { name: 'Error', message: `unknown run status "${status}"` };
    assert.throws(() => renderReply(runDir, 'codex-build', { status }), expected);
    assert.throws(() => exitCodeFor(status), expected);
  }
  for (const status of [undefined, null]) {
    assert.equal(exitCodeFor(status), EXIT.FAIL);
    assert.throws(() => renderReply(runDir, 'codex-build', { status }), {
      name: 'Error', message: `unknown run status "${status}"`,
    });
  }
});
