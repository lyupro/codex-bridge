/** Plan_80 E17/A12/A15: frozen automatic continuation reservations. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';
import { withTempTree } from '../temp-tree.mjs';
import { CONFIG_PATH, disableFlags } from '../../src/home/lib/run-config.mjs';
import { writeResumeArtifacts } from '../../src/home/lib/runner/resume-launch.mjs';
import { readResumeInputs } from '../../src/home/lib/runner/resume-inputs.mjs';
import { reserveRecoveryChild } from '../../src/home/lib/runner/recovery-launch.mjs';

const THREAD = '12345678-1234-1234-1234-123456789abc';
const STOPPED_AT = '2026-10-16T10:00:00.000Z';
const RESERVED_AT = '2026-10-17T12:00:00.000Z';
const PROFILE = { model: 'frozen-test-model', effort: 'high', speed: 'fast' };
const json = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const put = (dir, name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value), 'utf8');
const patch = (dir, name, value) => put(dir, name, { ...json(dir, name), ...value });
const directories = (root) => fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

function parentRun(root, name = 'parent') {
  const parentDir = path.join(root, name);
  fs.mkdirSync(parentDir);
  const meta = {
    continuation_eligibility: { automatic: { allowed: true } }, session_id: THREAD,
    stop: { session: { last_record_at: STOPPED_AT } },
    situation: { kind: 'silent-stall-candidate', silence_ms: 123456 },
  };
  put(parentDir, 'status.json', {
    state: 'finished', pid: 1, runner_pid: 2, launcher_pid: 3, process_started_at: 4,
    agent: 'codex-advisor', slug: name, order_id: 'recovery-order', phase: 'advise',
    task_hash: 'frozen-task-hash', task_hash_scheme: 'frozen-scheme', repo: root,
    advice: { frozen: true }, continues: 'chain-root', continued_from: 'previous',
    sandbox_probe: { granted: true }, started_at: '2026-10-16T09:00:00.000Z',
    retry_of: 'old-retry', retention: { days: 7 }, finished_at: STOPPED_AT, status: 'FAIL',
  });
  put(parentDir, 'worker.json', {
    agent: 'codex-advisor', slug: name, order_id: 'recovery-order', repo: root,
    is_git_repo: true, launcher_pid: 100, phase: 'advise', budget_minutes: 25,
    silence_policy: { enabled: true, frozen: 'silence' },
    recovery_policy: { budget_ms: 1102000, frozen: 'recovery' },
    scope_new: ['frozen/path'], profile: PROFILE, args: ['old'],
  });
  put(parentDir, 'meta.json', meta);
  fs.writeFileSync(path.join(parentDir, 'events.jsonl'),
    JSON.stringify({ type: 'thread.started', thread_id: THREAD }) + '\n', 'utf8');
  fs.writeFileSync(path.join(parentDir, 'task.md'), '# Frozen task - caf\u00e9 \u65e5\u672c\u8a9e.  \n', 'utf8');
  fs.writeFileSync(path.join(parentDir, 'schema.json'), '{\r\n "type": "object"\r\n}\r\n', 'utf8');
  fs.writeFileSync(path.join(parentDir, 'advisor-task.json'), '{ "question": "frozen" }\n', 'utf8');
  fs.writeFileSync(path.join(parentDir, 'env.json'), '\ufeff{\r\n "hooks": true, "plugins": false\r\n}\r\n', 'utf8');
  return { parentDir, meta, platform: 'linux', now: () => new Date(RESERVED_AT),
    readSession: ({ threadId, startedAt, referenceAt }) => {
      assert.equal(threadId, THREAD);
      assert.equal(startedAt, json(parentDir, 'status.json').started_at);
      assert.equal(referenceAt, null);
      return { state: 'observed', last_record_at: STOPPED_AT };
    } };
}

function unchanged(root, options, beforeDirs, beforeStatus) {
  assert.deepEqual(directories(root), beforeDirs);
  assert.deepEqual(fs.readFileSync(path.join(options.parentDir, 'status.json')), beforeStatus);
}

test('writes child status first, frozen artifacts and order next, parent link last; reserves once', async () => {
  await withTempTree('recovery-launch-', (root) => {
    const options = parentRun(root);
    const parentStatus = json(options.parentDir, 'status.json');
    const parentOrder = json(options.parentDir, 'worker.json');
    const write = fs.writeFileSync;
    const writes = [];
    const recording = mock.method(fs, 'writeFileSync', (file, ...args) => {
      writes.push(String(file));
      return write(file, ...args);
    });
    let result;
    try { result = reserveRecoveryChild(options); } finally { recording.mock.restore(); }
    assert.equal(result.reserved, true);
    const { childDir, order } = result;
    assert.deepEqual(writes, ['status.json', 'env.json', 'task-original.md', 'schema.json',
      'advisor-task.json', 'task.md', 'resume-note.md', 'worker.json'].map((name) => path.join(childDir, name))
      .concat(path.join(options.parentDir, 'status.json')));
    const child = json(childDir, 'status.json');
    for (const key of ['agent', 'slug', 'order_id', 'phase', 'task_hash', 'task_hash_scheme',
      'repo', 'advice', 'continues', 'continued_from', 'sandbox_probe']) {
      assert.deepEqual(child[key], parentStatus[key], key);
    }
    assert.equal(child.state, 'running');
    assert.equal(child.pid, process.pid);
    assert.equal(child.runner_pid, process.pid);
    assert.equal(child.process_started_at, performance.timeOrigin);
    assert.equal(child.started_at, RESERVED_AT);
    assert.notEqual(child.started_at, parentStatus.started_at);
    assert.equal(child.resumed_from, 'parent');
    assert.deepEqual(child.recovery,
      { automatic: true, attempt: 2, parent: 'parent', reserved_at: RESERVED_AT });
    for (const key of ['retry_of', 'retention', 'finished_at', 'status', 'launcher_pid']) {
      assert.equal(Object.hasOwn(child, key), false, key);
    }
    assert.equal(fs.existsSync(path.join(childDir, 'meta.json')), false);
    for (const [destination, source] of [['env.json', 'env.json'], ['task-original.md', 'task.md'],
      ['schema.json', 'schema.json'], ['advisor-task.json', 'advisor-task.json']]) {
      assert.deepEqual(fs.readFileSync(path.join(childDir, destination)),
        fs.readFileSync(path.join(options.parentDir, source)));
    }
    assert.equal(fs.readFileSync(path.join(childDir, 'resume-note.md'), 'utf8'),
      'Automatic continuation of parent after 123456 ms of session silence (Plan_80 B3).');
    assert.deepEqual(order, json(childDir, 'worker.json'));
    assert.equal(order.budget_minutes * 60000, 1102000);
    for (const key of ['agent', 'slug', 'order_id', 'repo', 'is_git_repo', 'phase',
      'silence_policy', 'recovery_policy', 'scope_new', 'profile']) {
      assert.deepEqual(order[key], parentOrder[key], key);
    }
    assert.equal(order.launcher_pid, process.pid);
    assert.equal(order.resume.thread_id, THREAD);
    assert.equal(order.resume.resumed_from, 'parent');
    assert.deepEqual(order.args.slice(0, 2), ['exec', 'resume']);
    assert.equal(order.args[order.args.indexOf('-o') + 1], path.join(childDir, 'result.json'));
    assert.deepEqual(json(options.parentDir, 'status.json'), { ...parentStatus, recovery: {
      child: path.basename(childDir), reserved_at: RESERVED_AT, automatic: true,
    } });
    const before = fs.readFileSync(path.join(options.parentDir, 'status.json'));
    assert.equal(reserveRecoveryChild(options).reason, 'already-reserved');
    assert.equal(directories(root).length, 2);
    unchanged(root, options, directories(root), before);
  });
});

const refusals = [
  ['not-allowed', (o) => { o.meta = undefined; }],
  ['not-allowed', (o) => { o.meta.continuation_eligibility.automatic.allowed = 'true'; }],
  ['parent-status-unreadable', (o) => fs.writeFileSync(path.join(o.parentDir, 'status.json'), '{')],
  ['parent-status-unreadable', (o) => put(o.parentDir, 'status.json', null)],
  ['already-reserved', (o) => patch(o.parentDir, 'status.json', { recovery: null })],
  ['recovery-budget-missing', (o) => fs.writeFileSync(path.join(o.parentDir, 'worker.json'), '{')],
  ...[undefined, 0, -1, 1.5, '1102000'].map((budget_ms) =>
    ['recovery-budget-missing', (o) => patch(o.parentDir, 'worker.json', { recovery_policy: { budget_ms } })]),
  ['inputs-unusable', (o) => fs.writeFileSync(path.join(o.parentDir, 'schema.json'), '{'),
    { reasons: ['artifact-malformed:schema.json'] }],
  ['thread-not-fresh', (o) => { o.readSession = () => ({ state: 'missing', reason: 'test' }); },
    { violation: 'thread-unreadable', values: { state: 'missing', reason: 'test' } }],
  ['thread-not-fresh', (o) => { o.readSession = () => ({ state: 'observed', last_record_at: RESERVED_AT }); },
    { violation: 'thread-advanced-after-stop', values: { recordedAt: STOPPED_AT, currentAt: RESERVED_AT } }],
  ['thread-not-fresh', (o) => { o.meta.stop.session.last_record_at = 'unknown'; }],
  ...['{', 'null', '[]', '42', '"string"'].map((text) =>
    ['environment-missing', (o) => fs.writeFileSync(path.join(o.parentDir, 'env.json'), text)]),
  ['arguments-invalid', (o) => patch(o.parentDir, 'status.json', { agent: 'unsupported-agent' })],
  ['arguments-unsafe', (o) => { o.platform = 'win32'; }, undefined, 'parent%unsafe'],
];

for (const [index, [reason, arrange, details, name]] of refusals.entries()) {
  test(`refusal ${index + 1}: ${reason} creates no folder and writes nothing`, async () => {
    await withTempTree('recovery-refusal-', (root) => {
      const options = parentRun(root, name);
      arrange(options);
      const beforeDirs = directories(root);
      const beforeStatus = fs.readFileSync(path.join(options.parentDir, 'status.json'));
      const writes = mock.method(fs, 'writeFileSync', () => { assert.fail('refusal wrote a file'); });
      let result;
      try { result = reserveRecoveryChild(options); } finally { writes.mock.restore(); }
      assert.equal(result.reserved, false);
      assert.equal(result.reason, reason);
      if (details) assert.deepEqual(result.details, details);
      if (reason === 'arguments-invalid') assert.equal(typeof result.details.message, 'string');
      if (reason === 'arguments-unsafe') assert.match(result.details.argument, /%/);
      unchanged(root, options, beforeDirs, beforeStatus);
    });
  });
}

test('missing files refuse at their boundary', async () => {
  for (const [name, reason] of [['status.json', 'parent-status-unreadable'],
    ['worker.json', 'recovery-budget-missing'], ['env.json', 'environment-missing']]) {
    await withTempTree('recovery-missing-', (root) => {
      const options = parentRun(root);
      const before = fs.readFileSync(path.join(options.parentDir, 'status.json'));
      const read = fs.readFileSync;
      const missing = mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === path.join(options.parentDir, name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return read(file, ...args);
      });
      let result;
      try { result = reserveRecoveryChild(options); } finally { missing.mock.restore(); }
      assert.equal(result.reason, reason);
      unchanged(root, options, ['parent'], before);
    });
  }
});

test('refusals preserve a-g precedence when later evidence is also unusable', async () => {
  await withTempTree('recovery-precedence-', (root) => {
    const options = parentRun(root);
    const checks = [
      () => patch(options.parentDir, 'status.json', { agent: 'unsupported-agent' }),
      () => put(options.parentDir, 'env.json', null),
      () => { options.readSession = () => ({ state: 'missing' }); },
      () => fs.writeFileSync(path.join(options.parentDir, 'schema.json'), '{'),
      () => patch(options.parentDir, 'worker.json', { recovery_policy: {} }),
      () => patch(options.parentDir, 'status.json', { recovery: {} }),
      () => fs.writeFileSync(path.join(options.parentDir, 'status.json'), '{'),
      () => { options.meta.continuation_eligibility.automatic.allowed = false; },
    ];
    const reasons = ['arguments-invalid', 'environment-missing', 'thread-not-fresh', 'inputs-unusable',
      'recovery-budget-missing', 'already-reserved', 'parent-status-unreadable', 'not-allowed'];
    for (const [index, arrange] of checks.entries()) {
      arrange();
      const before = fs.readFileSync(path.join(options.parentDir, 'status.json'));
      assert.equal(reserveRecoveryChild(options).reason, reasons[index]);
      unchanged(root, options, ['parent'], before);
    }
  });
});

test('parent flags override current hooks configuration without loading it', async () => {
  await withTempTree('recovery-flags-', (root) => {
    const options = parentRun(root);
    const today = { hooks: false, plugins: true };
    assert.ok(disableFlags(today).some((arg, i, args) => args[i - 1] === '--disable' && arg === 'hooks'));
    const read = fs.readFileSync;
    let configReads = 0;
    const config = mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === CONFIG_PATH) { configReads += 1; return JSON.stringify(today); }
      return read(file, ...args);
    });
    let result;
    try { result = reserveRecoveryChild(options); } finally { config.mock.restore(); }
    assert.equal(result.reserved, true);
    assert.equal(configReads, 0);
    assert.equal(result.order.args.some((arg, i, args) => args[i - 1] === '--disable' && arg === 'hooks'), false);
    assert.ok(result.order.args.some((arg, i, args) => args[i - 1] === '--disable' && arg === 'plugins'));
  });
});

test('same-second collision rebuilds argv for the actual child folder', async () => {
  await withTempTree('recovery-collision-', (root) => {
    const options = parentRun(root);
    const mkdir = fs.mkdirSync;
    let collided;
    const collision = mock.method(fs, 'mkdirSync', (dir, settings) => {
      if (!settings && !collided && path.dirname(dir) === root) {
        collided = dir;
        mkdir(dir);
        throw Object.assign(new Error('same-second collision'), { code: 'EEXIST' });
      }
      return mkdir(dir, settings);
    });
    let result;
    try { result = reserveRecoveryChild(options); } finally { collision.mock.restore(); }
    assert.equal(result.reserved, true);
    assert.equal(result.childDir, collided + '-2');
    assert.equal(result.order.args[result.order.args.indexOf('-o') + 1], path.join(result.childDir, 'result.json'));
    assert.equal(json(options.parentDir, 'status.json').recovery.child, path.basename(result.childDir));
    assert.deepEqual(fs.readdirSync(collided), []);
  });
});

for (const [kind, silence] of [['Bad Kind', undefined], [42, Infinity], [null, '123'], [undefined, NaN]]) {
  test(`unknown situation ${String(kind)} uses fallback and omits non-finite silence`, async () => {
    await withTempTree('recovery-kind-', (root) => {
      const options = parentRun(root);
      options.meta.situation = { kind, silence_ms: silence };
      const inputs = readResumeInputs(options.parentDir).inputs;
      const expected = path.join(root, 'expected');
      fs.mkdirSync(expected);
      writeResumeArtifacts({ runDir: expected, inputs, situationKind: 'evidence-unknown', note: 'expected' });
      const result = reserveRecoveryChild(options);
      assert.equal(result.reserved, true);
      assert.deepEqual(fs.readFileSync(path.join(result.childDir, 'task.md')),
        fs.readFileSync(path.join(expected, 'task.md')));
      assert.equal(fs.readFileSync(path.join(result.childDir, 'resume-note.md'), 'utf8'),
        'Automatic continuation of parent (Plan_80 B3).');
    });
  });
}

test('optional child status fields remain absent when absent from the parent', async () => {
  await withTempTree('recovery-optional-', (root) => {
    const options = parentRun(root);
    const status = json(options.parentDir, 'status.json');
    for (const key of ['advice', 'continues', 'continued_from', 'sandbox_probe']) delete status[key];
    put(options.parentDir, 'status.json', status);
    const result = reserveRecoveryChild(options);
    assert.equal(result.reserved, true);
    const child = json(result.childDir, 'status.json');
    for (const key of ['advice', 'continues', 'continued_from', 'sandbox_probe']) {
      assert.equal(Object.hasOwn(child, key), false, key);
    }
  });
});
