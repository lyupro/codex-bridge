/** Guards Plan_67 D4/D8 severity, recovery and current-host-only doctor rows. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { dispatcherModelChecks } from '../../cli/dispatcher-model-check.mjs';
import { check } from '../../cli/doctor-format.mjs';
import { DISPATCHER_MODEL_FILE } from '../../src/home/lib/dispatcher-model.mjs';
import { emptyLedger, reduceObservation } from '../../src/home/lib/observation-ledger.mjs';

const hostVersion = '2.1.281';
const at = '2026-10-07T10:00:00.000Z';
const stateDir = path.resolve('fixture-state');
const rows = (record, version = hostVersion) => dispatcherModelChecks({ record, hostVersion: version, stateDir });

function observe(ledger, verdict, data = {}) {
  const fields = { hostVersion, agentType: 'codex-build', pinFamily: 'haiku',
    parsed: verdict === 'violation' ? ['sonnet', 'opus'] : ['haiku'], ...data };
  return reduceObservation(ledger, {
    key: `${fields.hostVersion || 'unknown'}|${fields.agentType}`, verdict, at,
    detail: 'model comparison', data: fields,
  });
}

test('an absent or empty ledger is ok and not observed yet', () => {
  for (const record of [null, emptyLedger()]) {
    assert.deepEqual(rows(record), [check('dispatcherModel', 'ok',
      'Not observed yet — recorded when a dispatcher stops on this host.')]);
  }
});

test('a corrupt record warns once with the exact file to delete', () => {
  assert.deepEqual(rows({ corrupt: true }), [check('dispatcherModel', 'warn',
    `The dispatcher model record is unreadable; delete ${path.join(stateDir, DISPATCHER_MODEL_FILE)} to reset it.`)]);
});

test('a current-host violation fails with type, families, pin, time and quota warning', () => {
  const [row] = rows(observe(emptyLedger(), 'violation'));
  assert.equal(row.key, 'dispatcherModel:codex-build');
  assert.equal(row.status, 'fail');
  assert.match(row.value, /codex-build: observed families sonnet, opus, pinned family haiku/);
  assert.ok(row.value.includes(at));
  assert.match(row.value, /Claude quota was spent on this dispatcher; see Plan_67/);
});

test('an undetermined observation cannot disprove an earlier violation', () => {
  const ledger = observe(observe(emptyLedger(), 'violation'), 'undetermined', { parsed: [] });
  const [row] = rows(ledger);
  assert.equal(row.status, 'warn');
  assert.match(row.value, /not yet disproved/);
  assert.match(row.value, /earlier violation \(codex-build: observed families sonnet, opus, pinned family haiku/);
  assert.match(row.value, /no model family could be read from the transcript/);
});

test('an undetermined pin carries all installed-contract reasons', () => {
  const [row] = rows(observe(emptyLedger(), 'undetermined', {
    pinFamily: null, parsed: ['sonnet'],
    pinReasons: ['owner root missing; reinstall the owner', 'owners disagree on the pin'],
  }));
  assert.equal(row.status, 'warn');
  assert.match(row.value, /owner root missing; reinstall the owner; owners disagree on the pin/);
  assert.ok(row.value.includes(at));
  assert.doesNotMatch(row.value, /no model family could be read|not yet disproved/);
});

test('an undetermined transcript without pin reasons warns', () => {
  for (const reasons of [{}, { pinReasons: [] }]) {
    const [row] = rows(observe(emptyLedger(), 'undetermined', { parsed: [], ...reasons }));
    assert.equal(row.status, 'warn');
    assert.match(row.value, /codex-build: model observation undetermined/);
    assert.match(row.value, /no model family could be read from the transcript/);
  }
});

test('a clean match is ok and reports the observed family and pin', () => {
  const [row] = rows(observe(emptyLedger(), 'match'));
  assert.equal(row.status, 'ok');
  assert.match(row.value, /observed families haiku, pinned family haiku/);
  assert.match(row.value, /matches the installed contract/);
  assert.doesNotMatch(row.value, /recovered|earlier violation/);
});

test('recovery is determined by sequence and names the earlier violation as history', () => {
  // D8: equal timestamps still recover when the match was recorded later.
  const [row] = rows(observe(observe(emptyLedger(), 'violation'), 'match'));
  assert.equal(row.status, 'ok');
  assert.match(row.value, /observed families haiku, pinned family haiku/);
  assert.match(row.value, /recovered from earlier violation \(codex-build: observed families sonnet, opus/);
  assert.doesNotMatch(row.value, /not yet disproved/);
});

test('a fresh violation after recovery fails again', () => {
  const ledger = observe(observe(observe(emptyLedger(), 'violation'), 'match'), 'violation');
  assert.equal(rows(ledger)[0].status, 'fail');
});

test('latest uncertainty warns even after a clean match or recovery', () => {
  for (const ledger of [observe(emptyLedger(), 'match'),
    observe(observe(emptyLedger(), 'violation'), 'match')]) {
    const [row] = rows(observe(ledger, 'undetermined', { parsed: [] }));
    assert.equal(row.status, 'warn');
    assert.match(row.value, /no model family could be read from the transcript/);
    assert.doesNotMatch(row.value, /not yet disproved/);
  }
});

test('each current-host dispatcher type has its own row', () => {
  const ledger = observe(observe(emptyLedger(), 'match'), 'violation', { agentType: 'codex-review' });
  assert.deepEqual(rows(ledger).map(({ key, status }) => ({ key, status })), [
    { key: 'dispatcherModel:codex-build', status: 'ok' },
    { key: 'dispatcherModel:codex-review', status: 'fail' },
  ]);
});

test('other-host-only observations remain one ok row with one history sentence and host counts', () => {
  let ledger = observe(emptyLedger(), 'violation', { hostVersion: '2.1.280' });
  ledger = observe(ledger, 'match', { hostVersion: '2.1.280', agentType: 'codex-review' });
  ledger = observe(ledger, 'violation', { hostVersion: '2.1.279' });
  ledger = observe(ledger, 'undetermined', { hostVersion: '2.1.279', parsed: [] });
  const result = rows(ledger);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, 'dispatcherModel');
  assert.equal(result[0].status, 'ok');
  assert.match(result[0].value, /^Not observed yet/);
  assert.match(result[0].value, /History on other hosts \(historical, not current\):/);
  assert.ok(result[0].value.includes('2.1.280: 2 entries, 1 unresolved violations'));
  assert.ok(result[0].value.includes('2.1.279: 1 entries, 1 unresolved violations'));
  assert.equal(result[0].value.match(/History/g).length, 1);
});

test('other-host history is appended only to the first active row without extra warnings', () => {
  let ledger = observe(emptyLedger(), 'violation', { hostVersion: '2.1.280' });
  ledger = observe(ledger, 'match');
  ledger = observe(ledger, 'match', { agentType: 'codex-review' });
  const result = rows(ledger);
  assert.deepEqual(result.map((row) => row.status), ['ok', 'ok']);
  assert.match(result[0].value, /History on other hosts/);
  assert.doesNotMatch(result[1].value, /History/);
  assert.equal(result.length, 2);
});

test('a recovered other host counts as history without an unresolved violation', () => {
  const data = { hostVersion: '2.1.280' };
  const [row] = rows(observe(observe(emptyLedger(), 'violation', data), 'match', data));
  assert.equal(row.status, 'ok');
  assert.ok(row.value.includes('2.1.280: 1 entries, 0 unresolved violations'));
});

test('a match on another host cannot recover the current-host doctor violation', () => {
  const ledger = observe(observe(emptyLedger(), 'violation'), 'match', { hostVersion: '2.1.280' });
  const [row] = rows(ledger);
  assert.equal(row.status, 'fail');
  assert.match(row.value, /History on other hosts/);
});

test('a null host identity stays distinct from a known host', () => {
  const ledger = observe(emptyLedger(), 'violation', { hostVersion: null });
  assert.equal(rows(ledger, null)[0].status, 'fail');
  const [row] = rows(ledger);
  assert.equal(row.status, 'ok');
  assert.match(row.value, /unknown host: 1 entries, 1 unresolved violations/);
});
