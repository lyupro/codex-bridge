/** Guards manual enabling evidence under Plan_80 E15 (1) and E19. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { recoveryEnablingGatesCheck } from '../../cli/doctor-recovery-enabling-gates.mjs';
import { check } from '../../cli/doctor-format.mjs';
import { withTempTree } from '../temp-tree.mjs';

const now = new Date('2026-10-15T12:00:00');
const runsRoot = path.resolve('synthetic-enabling-runs');
const parentName = '2026-10-13_100000';
const recent = '2026-10-14_100000';
const empty = 'no manual resume trial of a stalled advise run in the last 30 days; enabling gate 0/3';
const inspect = '; inspect continuations whose parent or timing record could not be read';
const reached = ': gate reached — review every outcome and the shadow watchdog evidence, then decide O8 separately; doctor never enables recovery';

function record(run, meta, status = null, project = 'project') {
  return { project, run, runDir: path.join(runsRoot, project, run), meta, status };
}

function parent(run = parentName, meta = {}, project = 'project') {
  return record(run, {
    agent: 'codex-advisor', phase: 'advise', situation: { kind: 'silent-stall-candidate' }, ...meta,
  }, null, project);
}

function continuation(origin = parentName, meta = {}, status = { resumed_from: origin }, run = recent, project = 'project') {
  return record(run, {
    resumed_from: origin, status: 'OK', stop: { version: 2, elapsed_ms: 100 },
    recovery_policy: { version: 1, budget_ms: 100 }, ...meta,
  }, status, project);
}

function row(entries, options = {}) {
  return recoveryEnablingGatesCheck({
    runsRoot, now, records: { records: entries, days: 30, unreadable: 0 }, ...options,
  });
}

test('empty evidence and custom scan window retain exact text and unreadable suffix', () => {
  assert.deepEqual(row([]), check('recoveryEnablingGates', 'ok', empty));
  assert.deepEqual(row([], { records: { records: [], days: 7, unreadable: 2, statusUnreadable: 3 } }),
    check('recoveryEnablingGates', 'ok',
      'no manual resume trial of a stalled advise run in the last 7 days; enabling gate 0/3, 2 unreadable records skipped'));
});

test('manual OK and FAIL trials count separately but share one distinct parent, with no disk read', (t) => {
  t.mock.method(fs, 'readFileSync', () => assert.fail('a scanned parent must not be read again'));
  t.mock.method(fs, 'readdirSync', () => assert.fail('supplied records must not trigger a scan'));
  const entries = [continuation(), continuation(parentName, { status: 'FAIL' }, undefined, `${recent}-2`), parent()];
  assert.deepEqual(row(entries), check('recoveryEnablingGates', 'ok',
    '2 manual resume trials of stalled advise runs (1 distinct parents) in the last 30 days — OK 1, other outcome 1; timing: within budget 2, over budget 0, unknown 0; enabling gate 1/3: 2 more needed'));
});

test('automatic children do not establish manual enabling evidence', (t) => {
  t.mock.method(fs, 'readFileSync', () => assert.fail('ignored children must not read parents'));
  const origin = parentName;
  const status = { resumed_from: origin, recovery: { automatic: true, attempt: 2, parent: origin } };
  assert.deepEqual(row([continuation(origin, {}, status)]), check('recoveryEnablingGates', 'ok', empty));
});

test('mismatched, absent, or non-object status and absent meta origins are ignored', (t) => {
  t.mock.method(fs, 'readFileSync', () => assert.fail('ignored continuations must not read parents'));
  for (const status of [null, undefined, false, 1, 'status', [], {}, { resumed_from: `${parentName}-other` }]) {
    const child = continuation();
    child.status = status;
    assert.deepEqual(row([child]), check('recoveryEnablingGates', 'ok', empty));
  }
  for (const meta of [null, {}, { resumed_from: '' }]) {
    const child = continuation();
    child.meta = meta;
    assert.deepEqual(row([child]), check('recoveryEnablingGates', 'ok', empty));
  }
});

for (const origin of ['../x', 'a/b', 'a\\b', '.', '..', '', '   ', 'C:parent']) {
  test(`unsafe or empty resume origin ${JSON.stringify(origin)} is ignored`, (t) => {
    t.mock.method(fs, 'readFileSync', () => assert.fail('unsafe names must not cause a parent read'));
    assert.deepEqual(row([continuation(origin)]), check('recoveryEnablingGates', 'ok', empty));
  });
}

for (const meta of [
  { agent: 'codex-scout' }, { phase: 'default' }, { situation: { kind: 'deadline' } },
  { agent: undefined }, { phase: undefined }, { situation: null },
]) {
  test(`a known parent of another kind is not a trial: ${JSON.stringify(meta)}`, (t) => {
    t.mock.method(fs, 'readFileSync', () => assert.fail('a known non-trial parent must not be read again'));
    assert.deepEqual(row([parent(parentName, meta), continuation()]), check('recoveryEnablingGates', 'ok', empty));
  });
}

test('an unknown parent warns without counting a trial or contributing to the gate', (t) => {
  let reads = 0;
  t.mock.method(fs, 'readFileSync', () => {
    reads += 1;
    throw Object.assign(new Error('missing parent'), { code: 'ENOENT' });
  });
  const result = row([continuation(), continuation(parentName, {}, undefined, `${recent}-2`)], {
    records: { records: [continuation(), continuation(parentName, {}, undefined, `${recent}-2`)], days: 30, unreadable: 1 },
  });
  assert.deepEqual(result, check('recoveryEnablingGates', 'warn',
    '0 manual resume trials of stalled advise runs (0 distinct parents) in the last 30 days — OK 0, other outcome 0; timing: within budget 0, over budget 0, unknown 0; enabling gate 0/3: 3 more needed; parent unknown 2, 1 unreadable records skipped' + inspect));
  assert.equal(reads, 1, 'missing parents are cached for this call');
});

test('zero and equality are within budget; exceeding it is informational even for a deadline outcome', () => {
  const entries = [parent(),
    continuation(parentName, { stop: { version: 2, elapsed_ms: 0 } }),
    continuation(parentName, {}, undefined, `${recent}-equal`),
    continuation(parentName, { status: 'FAIL', stop: { version: 2, elapsed_ms: 101, trigger: 'deadline' } },
      undefined, `${recent}-over`),
  ];
  assert.deepEqual(row(entries), check('recoveryEnablingGates', 'ok',
    '3 manual resume trials of stalled advise runs (1 distinct parents) in the last 30 days — OK 2, other outcome 1; timing: within budget 2, over budget 1, unknown 0; enabling gate 1/3: 2 more needed'));
});

const invalidTiming = [
  ['missing stop', { stop: undefined }], ['null stop', { stop: null }],
  ['missing stop version', { stop: { elapsed_ms: 100 } }],
  ['old stop version', { stop: { version: 1, elapsed_ms: 100 } }],
  ['string stop version', { stop: { version: '2', elapsed_ms: 100 } }],
  ...[undefined, null, '100', NaN, Infinity, -Infinity, -1].map((elapsed_ms) =>
    [`invalid elapsed ${String(elapsed_ms)}`, { stop: { version: 2, elapsed_ms } }]),
  ['missing policy', { recovery_policy: undefined }], ['null policy', { recovery_policy: null }],
  ['missing policy version', { recovery_policy: { budget_ms: 100 } }],
  ['unknown policy version', { recovery_policy: { version: 2, budget_ms: 100 } }],
  ['string policy version', { recovery_policy: { version: '1', budget_ms: 100 } }],
  ...[undefined, null, '100', NaN, Infinity, -Infinity, 0, -1, 1.5].map((budget_ms) =>
    [`invalid budget ${String(budget_ms)}`, { recovery_policy: { version: 1, budget_ms } }]),
];
for (const [label, meta] of invalidTiming) {
  test(`${label} leaves timing unknown and warns`, () => {
    assert.deepEqual(row([parent(), continuation(parentName, meta)]), check('recoveryEnablingGates', 'warn',
      '1 manual resume trials of stalled advise runs (1 distinct parents) in the last 30 days — OK 1, other outcome 0; timing: within budget 0, over budget 0, unknown 1; enabling gate 1/3: 2 more needed' + inspect));
  });
}

for (const status of ['FAIL', null, undefined, 'ok']) {
  test(`only exact OK is a successful outcome: ${String(status)}`, () => {
    assert.deepEqual(row([parent(), continuation(parentName, { status })]), check('recoveryEnablingGates', 'ok',
      '1 manual resume trials of stalled advise runs (1 distinct parents) in the last 30 days — OK 0, other outcome 1; timing: within budget 1, over budget 0, unknown 0; enabling gate 1/3: 2 more needed'));
  });
}

test('two distinct parents need one more; three reach the gate without warning, capped at three', () => {
  const entries = [];
  for (let index = 1; index <= 4; index += 1) {
    const name = `${parentName}-${index}`;
    entries.push(parent(name), continuation(name, {}, undefined, `${recent}-${index}`));
    if (index === 1) continue;
    const tail = index >= 3 ? reached : ': 1 more needed';
    assert.deepEqual(row(entries), check('recoveryEnablingGates', 'ok',
      `${index} manual resume trials of stalled advise runs (${index} distinct parents) in the last 30 days — OK ${index}, other outcome 0; timing: within budget ${index}, over budget 0, unknown 0; enabling gate ${Math.min(index, 3)}/3${tail}`));
  }
});

test('distinct parent identity includes the project and the parent lookup stays in that project', (t) => {
  const entries = ['one', 'two', 'three'].flatMap((project) => [
    parent(parentName, {}, project), continuation(parentName, {}, undefined, recent, project),
  ]);
  t.mock.method(fs, 'readFileSync', () => { throw new Error('parent absent in this project'); });
  entries.push(continuation(parentName, {}, undefined, recent, 'four'));
  assert.deepEqual(row(entries), check('recoveryEnablingGates', 'warn',
    '3 manual resume trials of stalled advise runs (3 distinct parents) in the last 30 days — OK 3, other outcome 0; timing: within budget 3, over budget 0, unknown 0; enabling gate 3/3' + reached + '; parent unknown 1' + inspect));
});

test('gate progress still reports unknown timing instead of treating it as clean', () => {
  const entries = [1, 2, 3].flatMap((index) => [
    parent(`${parentName}-${index}`),
    continuation(`${parentName}-${index}`, index === 3 ? { stop: null } : {}, undefined, `${recent}-${index}`),
  ]);
  assert.deepEqual(row(entries), check('recoveryEnablingGates', 'warn',
    '3 manual resume trials of stalled advise runs (3 distinct parents) in the last 30 days — OK 3, other outcome 0; timing: within budget 2, over budget 0, unknown 1; enabling gate 3/3' + reached + inspect));
});

test('scan errors warn verbatim and never read a parent', (t) => {
  t.mock.method(fs, 'readFileSync', () => assert.fail('scan errors must not read parents'));
  const error = 'runs root scan unavailable: fixture denied';
  assert.deepEqual(row([], { records: { error } }), check('recoveryEnablingGates', 'warn', error));
});

test('out-of-window parents are read once per call, including missing, corrupt, and denied metadata', async (t) => {
  await withTempTree('enabling-parent-cache-', (root) => {
    const origins = ['2026-08-01_100000', '2026-08-02_100000', '2026-08-03_100000', '2026-08-04_100000'];
    const files = origins.map((origin) => path.join(root, 'project', origin, 'meta.json'));
    for (let index = 0; index < 3; index += 1) {
      fs.mkdirSync(path.dirname(files[index]), { recursive: true });
      fs.writeFileSync(files[index], index === 1 ? '{' : JSON.stringify(parent().meta));
    }
    for (const [index, origin] of origins.entries()) {
      for (let childIndex = 0; childIndex < 2; childIndex += 1) {
        const child = continuation(origin, {}, undefined, `${recent}-${index}-${childIndex}`);
        const folder = path.join(root, child.project, child.run);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(child.meta));
        fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify(child.status));
      }
    }
    const reads = new Map();
    const read = fs.readFileSync;
    const readMock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (files.includes(file)) reads.set(file, (reads.get(file) ?? 0) + 1);
      if (file === files[2]) throw Object.assign(new Error('parent denied'), { code: 'EACCES' });
      return read(file, ...args);
    });
    try {
      for (let call = 1; call <= 2; call += 1) {
        assert.deepEqual(recoveryEnablingGatesCheck({ runsRoot: root, now }), check('recoveryEnablingGates', 'warn',
          '2 manual resume trials of stalled advise runs (1 distinct parents) in the last 30 days — OK 2, other outcome 0; timing: within budget 2, over budget 0, unknown 0; enabling gate 1/3: 2 more needed; parent unknown 6' + inspect));
        for (const file of files) assert.equal(reads.get(file), call, 'parent cache is scoped to one check call');
      }
      const missingRoot = recoveryEnablingGatesCheck({ runsRoot: path.join(root, 'missing'), now });
      assert.equal(missingRoot.status, 'warn');
      assert.match(missingRoot.value, /^runs root unavailable: .*ENOENT/);
    } finally {
      readMock.mock.restore();
    }
  });
});
