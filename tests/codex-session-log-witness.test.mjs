/** Plan_80 E13/O9: resumed turns must supply their own sandbox evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readSessionActivity } from '../src/home/lib/codex-session-log.mjs';
import { withTempTree } from './temp-tree.mjs';

const THREAD = '00000000-0000-4000-8000-000000000009';
const START = new Date(2026, 0, 4, 12).toISOString();
const at = (offset) => new Date(Date.parse(START) + offset).toISOString();
const record = (type, payload, timestamp = START, ordinal = 1) => ({ timestamp, ordinal, type, payload });
const meta = () => record('session_meta', { id: THREAD }, at(-4 * 86400000), 0);
const turn = (policy, timestamp = START, ordinal = 1) => record('turn_context', {
  sandbox_policy: { type: policy, private: 'PRIVATE_SANDBOX_PAYLOAD' }, cwd: 'PRIVATE_TURN_CWD',
}, timestamp, ordinal);
const jsonl = (entries) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
const absent = { state: 'absent', policy: null, at: null };
const notObserved = { state: 'not-observed', policy: null, at: null };

function fixture(home, entries, offset = 0) {
  const day = new Date(START);
  day.setDate(day.getDate() + offset);
  const date = [String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0')];
  const folder = path.join(home, 'sessions', ...date);
  fs.mkdirSync(folder, { recursive: true });
  const file = `rollout-${date.join('-')}T12-00-00-${THREAD}.jsonl`;
  const fullPath = path.join(folder, file);
  fs.writeFileSync(fullPath, typeof entries === 'string' ? entries : jsonl(entries), 'utf8');
  return { file, fullPath, folder };
}

function read(home, options = {}) {
  const result = readSessionActivity({ threadId: THREAD, startedAt: START, codexHome: home, ...options });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SANDBOX_PAYLOAD'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TURN_CWD'));
  return result;
}

test('fallback finds the original thread file three days before the resumed run', async () => {
  await withTempTree('session-witness-', (home) => {
    const { file } = fixture(home, [meta(), turn('read-only')], -3);
    const result = read(home);
    assert.equal(result.state, 'observed');
    assert.equal(result.file, file);
    assert.deepEqual(result.sandbox_witness, { state: 'observed', policy: 'read-only', at: START });
  });
});

for (const offset of [0, -1, 1]) {
  test(`near-day lookup (${offset}) wins without starting the fallback`, async (t) => {
    await withTempTree('session-witness-', (home) => {
      fixture(home, [meta(), turn('workspace-write')], -3);
      const { file } = fixture(home, [meta(), turn('read-only')], offset);
      const readdir = fs.readdirSync;
      const spy = t.mock.method(fs, 'readdirSync', (folder, options) => {
        assert.equal(options, undefined, 'fallback must not list date directory entries');
        return readdir(folder, options);
      });
      try {
        const result = read(home);
        assert.equal(result.state, 'observed');
        assert.equal(result.file, file);
        assert.equal(result.sandbox_witness.policy, 'read-only');
        assert.equal(spy.mock.callCount(), [0, -1, 1].indexOf(offset) + 1);
      } finally { spy.mock.restore(); }
    });
  });
}

test('fallback searches newest day first across day, month and year boundaries', async () => {
  await withTempTree('session-witness-', (home) => {
    for (const offset of [-3, -4, -35, -400]) fixture(home, [meta(), turn(`policy-${offset}`)], offset);
    assert.deepEqual(read(home).sandbox_witness, { state: 'observed', policy: 'policy--3', at: START });
  });
});

test('fallback ignores directories outside the date shape', async (t) => {
  await withTempTree('session-witness-', (home) => {
    const { fullPath, file } = fixture(home, [meta(), turn('read-only')], -3);
    const sessions = path.join(home, 'sessions');
    const ignored = [path.join(sessions, 'unrelated'), path.join(sessions, '2026', '1'),
      path.join(sessions, '2026', '01', '1')];
    for (const folder of ignored) {
      fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(fullPath, path.join(folder, file));
    }
    const readdir = fs.readdirSync;
    const spy = t.mock.method(fs, 'readdirSync', (folder, options) => {
      assert.ok(!ignored.includes(folder), `unexpected directory listing: ${folder}`);
      return readdir(folder, options);
    });
    try { assert.equal(read(home).state, 'observed'); }
    finally { spy.mock.restore(); }
  });
});

test('no sessions folder stays missing with a not-observed witness', async () => {
  await withTempTree('session-witness-', (home) => {
    const result = read(home);
    assert.equal(result.state, 'missing');
    assert.deepEqual(result.sandbox_witness, notObserved);
  });
});

test('the last qualifying turn wins, exposing only the policy type and timestamp', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), turn('read-only', at(1000)), turn('workspace-write', at(2000), 2)]);
    const result = read(home);
    assert.equal(result.state, 'observed');
    assert.deepEqual(result.sandbox_witness, { state: 'observed', policy: 'workspace-write', at: at(2000) });
  });
});

test('a turn before startedAt cannot vouch for a resumed run', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), turn('read-only', at(-1))]);
    assert.deepEqual(read(home).sandbox_witness, absent);
  });
});

test('a turn exactly at startedAt qualifies', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), turn('read-only')]);
    assert.deepEqual(read(home).sandbox_witness, { state: 'observed', policy: 'read-only', at: START });
  });
});

test('turn_context without sandbox_policy provides no witness', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), record('turn_context', { cwd: 'PRIVATE_TURN_CWD' })]);
    assert.deepEqual(read(home).sandbox_witness, absent);
  });
});

test('only a non-empty string type on turn_context qualifies', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), ...[null, undefined, '', 42, {}, []].map((policy, index) =>
      turn(policy, at(index), index + 1)), record('event_msg', { sandbox_policy: { type: 'read-only' } })]);
    assert.deepEqual(read(home).sandbox_witness, absent);
  });
});

test('later nonqualifying records do not erase the last qualifying turn', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), turn('read-only'), turn('workspace-write', at(-1), 2),
      record('turn_context', {}, at(1000), 3)]);
    assert.deepEqual(read(home).sandbox_witness, { state: 'observed', policy: 'read-only', at: START });
  });
});

test('the last qualifying turn follows file order rather than the largest timestamp', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), turn('read-only', at(2000)), turn('workspace-write', at(1000), 2)]);
    assert.deepEqual(read(home).sandbox_witness, { state: 'observed', policy: 'workspace-write', at: at(1000) });
  });
});

for (const tail of ['{', '{\n', '']) {
  test(`incomplete final line discards any witness (${JSON.stringify(tail)})`, async () => {
    await withTempTree('session-witness-', (home) => {
      const content = jsonl([meta(), turn('read-only')]);
      fixture(home, tail ? content + tail : content.slice(0, -1));
      const result = read(home);
      assert.equal(result.state, 'incomplete');
      assert.deepEqual(result.sandbox_witness, notObserved);
    });
  });
}

test('an invalid record after a valid turn discards its witness', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, [meta(), turn('read-only'), record('event_msg', null)]);
    const result = read(home);
    assert.equal(result.state, 'unrecognized');
    assert.deepEqual(result.sandbox_witness, notObserved);
  });
});

test('an empty file has a not-observed witness', async () => {
  await withTempTree('session-witness-', (home) => {
    fixture(home, '');
    const result = read(home);
    assert.equal(result.state, 'empty');
    assert.deepEqual(result.sandbox_witness, notObserved);
  });
});

test('no thread id has a not-observed witness without touching the filesystem', async (t) => {
  await withTempTree('session-witness-', (home) => {
    const spy = t.mock.method(fs, 'readdirSync', () => assert.fail('unexpected directory listing'));
    try {
      const result = read(home, { threadId: null });
      assert.equal(result.state, 'not-observed');
      assert.deepEqual(result.sandbox_witness, notObserved);
      assert.equal(spy.mock.callCount(), 0);
    } finally { spy.mock.restore(); }
  });
});

test('an unknown start time has a not-observed witness', async () => {
  await withTempTree('session-witness-', (home) => {
    const result = read(home, { startedAt: undefined });
    assert.equal(result.state, 'not-observed');
    assert.deepEqual(result.sandbox_witness, notObserved);
  });
});

test('a read failure has a not-observed witness', async (t) => {
  await withTempTree('session-witness-', (home) => {
    const { fullPath } = fixture(home, [meta(), turn('read-only')]);
    const readFile = fs.readFileSync;
    const spy = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === fullPath) throw new Error('synthetic read failure');
      return readFile(file, ...args);
    });
    try {
      const result = read(home);
      assert.equal(result.state, 'unreadable');
      assert.deepEqual(result.sandbox_witness, notObserved);
    } finally { spy.mock.restore(); }
  });
});
