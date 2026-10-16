/** Plan_80 E13/O9: only a witnessed read-only resumed turn can vouch for its result. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { resumeOrigin, sandboxWitnessGap, sandboxWitnessRow } from '../../src/home/lib/meta/sandbox-witness.mjs';

const at = '2026-10-16T10:00:00.000Z';
const unconfirmedRow = 'Sandbox witness: not observed — the session log was not read to the end; read-only is not confirmed';
const absentRow = 'Sandbox witness: absent — the session log records no sandbox policy for the resumed turn; read-only is not confirmed';
const readOnlyRow = `Sandbox witness: read-only — session log at ${at}`;
const unsafeRow = 'Sandbox witness: workspace-write — not read-only; the result is not trusted';
const unsafeReason = `resume turn ran with sandbox policy "workspace-write" (session log at ${at}), not read-only; its result is not trusted`;

function runWithStatus(status) {
  const dir = makeTempTree('sandbox-witness-');
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(status)}\n`, 'utf8');
  return dir;
}

function resumedStatus(witness) {
  return { resumed_from: 'failed-pass', stop: { session: { sandbox_witness: witness } } };
}

test('resumeOrigin preserves valid bare folder names exactly', () => {
  for (const resumed_from of ['failed-pass', ' pass ', '.pass', 'pass..']) {
    assert.equal(resumeOrigin({ resumed_from }), resumed_from);
  }
});

test('resumeOrigin rejects missing, empty, non-string and non-bare origins', () => {
  for (const resumed_from of [undefined, null, '', '   ', 42, {}, '../pass', '..\\pass',
    '/pass', 'C:\\runs\\pass', 'C:pass', 'C:', 'parent/pass', 'parent\\pass', '.', '..']) {
    assert.equal(resumeOrigin({ resumed_from }), null);
  }
  assert.equal(resumeOrigin(null), null);
  assert.equal(resumeOrigin(undefined), null);
});

for (const [state, policy, gap, row] of [
  ['observed', 'read-only', null, readOnlyRow],
  ['observed', 'workspace-write', unsafeReason, unsafeRow],
  ['absent', null, null, absentRow],
  ['not-observed', null, null, unconfirmedRow],
  ['unknown', 'workspace-write', null, unconfirmedRow],
]) {
  test(`a resume with witness ${state}/${policy} reports its evidence without guessing`, () => {
    const dir = runWithStatus(resumedStatus({ state, policy, at }));
    assert.equal(sandboxWitnessGap(dir), gap);
    assert.equal(sandboxWitnessRow(dir), row);
  });
}

test('missing stop, session and witness records leave a resume unconfirmed', () => {
  for (const stop of [undefined, null, {}, { session: null }, { session: {} }]) {
    const dir = runWithStatus({ resumed_from: 'failed-pass', stop });
    assert.equal(sandboxWitnessGap(dir), null);
    assert.equal(sandboxWitnessRow(dir), unconfirmedRow);
  }
});

test('fresh runs and invalid resume origins never acquire witness verdicts or rows', () => {
  for (const [resumed_from, policy] of [[undefined, 'danger-full-access'], ['../pass', 'workspace-write']]) {
    const dir = runWithStatus({
      resumed_from, stop: { session: { sandbox_witness: { state: 'observed', policy, at } } },
    });
    assert.equal(sandboxWitnessGap(dir), null);
    assert.equal(sandboxWitnessRow(dir), null);
  }
});

test('only the exact observed read-only policy is trusted', () => {
  for (const policy of ['READ-ONLY', ' read-only ', '', null, undefined]) {
    const dir = runWithStatus(resumedStatus({ state: 'observed', policy, at }));
    assert.match(sandboxWitnessGap(dir), /not read-only; its result is not trusted$/);
    assert.match(sandboxWitnessRow(dir), /not read-only; the result is not trusted$/);
  }
});

test('witness policy and timestamp are flattened and bounded to 60 characters', () => {
  const policy = `\r\n${'x'.repeat(80)}\tunsafe`;
  const timestamp = `\n${'y'.repeat(80)}\r\nextra`;
  const boundedPolicy = `${'x'.repeat(57)}...`;
  const boundedAt = `${'y'.repeat(57)}...`;
  const dir = runWithStatus(resumedStatus({ state: 'observed', policy, at: timestamp }));
  assert.equal(sandboxWitnessGap(dir), `resume turn ran with sandbox policy "${boundedPolicy}" `
    + `(session log at ${boundedAt}), not read-only; its result is not trusted`);
  assert.equal(sandboxWitnessRow(dir), `Sandbox witness: ${boundedPolicy} — not read-only; the result is not trusted`);
  const readOnlyDir = runWithStatus(resumedStatus({ state: 'observed', policy: 'read-only', at: timestamp }));
  assert.equal(sandboxWitnessRow(readOnlyDir), `Sandbox witness: read-only — session log at ${boundedAt}`);
});

test('absent, unreadable and malformed status artifacts do not invent a resume', () => {
  const dir = makeTempTree('sandbox-witness-missing-');
  assert.equal(sandboxWitnessGap(dir), null);
  assert.equal(sandboxWitnessRow(dir), null);
  for (const contents of ['{broken', '', 'null', '{}']) {
    fs.writeFileSync(path.join(dir, 'status.json'), contents, 'utf8');
    assert.equal(sandboxWitnessGap(dir), null);
    assert.equal(sandboxWitnessRow(dir), null);
  }
});

for (const [policy, expectedStatus, expectedReason, expectedRow] of [
  ['workspace-write', 'FAIL', unsafeReason, unsafeRow],
  ['read-only', 'OK', null, readOnlyRow],
]) {
  test(`collect judges a filled valid resume result witnessed under ${policy}`, () => {
    const dir = makeRun({
      status: resumedStatus({ state: 'observed', policy, at }),
      result: buildResult([]), before: '', after: '',
      args: ['exec', 'resume', '--json', '-c', 'sandbox_mode=read-only', 'resume-thread'],
      events: [{ type: 'thread.started', thread_id: 'resume-thread' }],
    });
    const { meta, reply } = collect(dir, 'codex-build', 0);
    assert.equal(meta.result_ok, true);
    assert.equal(meta.status, expectedStatus, meta.reason);
    assert.equal(meta.reason, expectedReason);
    const rows = reply.split('\n');
    const attemptAt = rows.indexOf("Attempt: resume of failed-pass — continues that pass's Codex thread");
    assert.ok(attemptAt >= 0);
    assert.equal(rows[attemptAt + 1], expectedRow);
    assert.equal(rows.filter((row) => row.startsWith('Sandbox witness:')).length, 1);
  });
}

for (const witness of [{ state: 'absent' }, { state: 'not-observed' }, undefined]) {
  test(`collect keeps an unconfirmed resume result OK (${witness?.state ?? 'missing'})`, () => {
    const dir = makeRun({ status: resumedStatus(witness), result: buildResult([]) });
    const { meta, reply } = collect(dir, 'codex-build', 0);
    assert.equal(meta.status, 'OK', meta.reason);
    assert.ok(reply.includes(witness?.state === 'absent' ? absentRow : unconfirmedRow));
  });
}

test('resolveStatus checks the witness after the transport-error branch and before absent results', () => {
  const source = fs.readFileSync(new URL('../../src/home/lib/meta/verdict.mjs', import.meta.url), 'utf8');
  const resolveAt = source.indexOf('export function resolveStatus(');
  const transportAt = source.indexOf('if (transportError) {', resolveAt);
  const transportReturnAt = source.indexOf('reason: transportError.reason,', transportAt);
  const transportEndAt = source.indexOf('\n  }', transportReturnAt);
  const witnessAt = source.indexOf('const witness = sandboxWitnessGap(runDir);', resolveAt);
  const witnessReturnAt = source.indexOf("if (witness) return { status: 'FAIL', reason: witness };", witnessAt);
  const absentAt = source.indexOf('if (!resultOk)', resolveAt);
  assert.ok(resolveAt >= 0 && transportAt > resolveAt && transportReturnAt > transportAt);
  assert.ok(transportEndAt > transportReturnAt && witnessAt > transportEndAt);
  assert.ok(witnessReturnAt > witnessAt && absentAt > witnessReturnAt);
});
