import assert from 'node:assert/strict';
import { test } from 'node:test';
import { otherHostCheck, sessionHostCheck, sessionHostVersions } from '../../cli/session-hosts.mjs';
import { DISPATCHER_CONTRACTS } from '../../cli/dispatcher-contract.mjs';
import { PROBE_COMMAND } from '../../cli/host-contract.mjs';

const date1 = '2026-09-24T12:00:00.000Z';
const date2 = '2026-09-25T12:00:00.000Z';
const observed = { hosts: { '2.1.281': { lastSeen: date1 }, '2.1.282': { lastSeen: date2 }, bad: { lastSeen: 'bad' } } };
const complete = (version) => ({ hosts: { [version]: { result: 'honored', checkedAt: date1 } } });
const dispatchers = (version, result = 'honored') => ({ hosts: { [version]: { contracts: Object.fromEntries(
  DISPATCHER_CONTRACTS.map((name) => [name, { result, checkedAt: date1 }]),
) } } });

test('session host versions sort by lastSeen and omit invalid dates', () => {
  assert.deepEqual(sessionHostVersions(observed), ['2.1.282', '2.1.281']);
});

test('session host check reports none, one, and multiple observations', () => {
  assert.deepEqual(sessionHostCheck([], { hosts: {} }), {
    key: 'sessionHost', status: 'warn',
    value: 'No Claude Code session has been observed by this installation yet; host contracts are judged once a session runs a shell command.',
  });
  assert.deepEqual(sessionHostCheck(['2.1.282'], observed), {
    key: 'sessionHost', status: 'ok', value: `Sessions run on host 2.1.282 (last seen ${date2})`,
  });
  assert.match(sessionHostCheck(['2.1.282', '2.1.281'], observed).value,
    /; also seen: 2\.1\.281$/);
});

test('other host check verifies all measured contracts', () => {
  assert.equal(otherHostCheck({ version: '2.1.282', contractRecord: complete('2.1.282'),
    dispatcherRecord: dispatchers('2.1.282') }).status, 'ok');
});

test('other host check warns with missing contracts and a probe command', () => {
  const result = otherHostCheck({ version: '2.1.282', contractRecord: null,
    dispatcherRecord: null });
  assert.equal(result.status, 'warn');
  for (const name of ['refusal', ...DISPATCHER_CONTRACTS]) assert.ok(result.value.includes(name));
  assert.ok(result.value.includes(`${PROBE_COMMAND} --probe-executable <path to a 2.1.282 executable>`));
});

test('other host check fails ignored refusal and changed dispatcher contracts', () => {
  const ignored = otherHostCheck({ version: '2.1.282',
    contractRecord: { hosts: { '2.1.282': { result: 'ignored' } } }, dispatcherRecord: dispatchers('2.1.282') });
  assert.equal(ignored.status, 'fail');
  const changed = otherHostCheck({ version: '2.1.282', contractRecord: complete('2.1.282'),
    dispatcherRecord: dispatchers('2.1.282', 'changed') });
  assert.equal(changed.status, 'fail');
});
