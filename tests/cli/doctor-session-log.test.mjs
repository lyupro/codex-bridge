/** Plan_80 E11: doctor must notice real-log format drift without printing payload content. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sessionLogCheck } from '../../cli/doctor-session-log.mjs';
import { withTempTree } from '../temp-tree.mjs';

const THREAD = '11111111-2222-4333-8444-555555555555';
const TIME = '2026-10-15T10:20:30.000Z';
const PLACEHOLDERS = ['PLACEHOLDER_PROMPT', 'PLACEHOLDER_RESPONSE', 'PLACEHOLDER_CWD', 'PLACEHOLDER_MODEL'];
// doctor passes a time value, not a clock function (cli/active-hosts.mjs).
const now = new Date('2026-10-15T10:21:00.000Z');
const nameAt = (date, time = '10-20-00', threadId = THREAD) => `rollout-${date}T${time}-${threadId}.jsonl`;

function records() {
  return [
    {
      timestamp: '2026-10-15T10:20:00.000Z', ordinal: 0, type: 'session_meta',
      payload: { id: THREAD, cwd: PLACEHOLDERS[2], model: PLACEHOLDERS[3] },
    },
    {
      timestamp: TIME, ordinal: 1, type: 'event_msg',
      payload: { type: 'user_message', message: PLACEHOLDERS[0], response: PLACEHOLDERS[1] },
    },
  ];
}

function writeRollout(codexHome, date = '2026-10-15', time = '10-20-00', source) {
  const folder = path.join(codexHome, 'sessions', ...date.split('-'));
  fs.mkdirSync(folder, { recursive: true });
  const name = nameAt(date, time);
  const file = path.join(folder, name);
  fs.writeFileSync(file, source ?? `${records().map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { name, file, folder };
}

function noPayload(row) {
  for (const placeholder of PLACEHOLDERS) assert.ok(!row.value.includes(placeholder), row.value);
}

test('recognized log reports the file, record count, last kind and timestamp without payload values', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    const { name } = writeRollout(codexHome);
    const row = sessionLogCheck({ codexHome, now });
    assert.deepEqual(row, {
      key: 'sessionLog', status: 'ok',
      value: `recognized: ${name}, 2 records, last event_msg/user_message at ${TIME}`,
    });
    noPayload(row);
  });
});

for (const [dimension, dates] of [
  ['year', ['2025-12-31', '2026-01-01']],
  ['month', ['2026-09-30', '2026-10-01']],
  ['day', ['2026-10-14', '2026-10-15']],
]) {
  test(`chooses the newest ${dimension} folder, even when the older log is broken`, async () => {
    await withTempTree('doctor-session-log-', (codexHome) => {
      const expected = writeRollout(codexHome, dates[1]);
      writeRollout(codexHome, dates[0], '23-59-59', `${JSON.stringify({ payload: PLACEHOLDERS[0] })}\n`);
      const row = sessionLogCheck({ codexHome, now });
      assert.equal(row.status, 'ok');
      assert.ok(row.value.startsWith(`recognized: ${expected.name}, 2 records,`));
      noPayload(row);
    });
  });
}

test('chooses the highest rollout name in the newest nonempty date folder', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    const expected = writeRollout(codexHome, '2026-10-15', '23-59-59');
    fs.writeFileSync(path.join(expected.folder, nameAt('2026-10-15', '00-00-01', 'aaaaaaaa-2222-4333-8444-555555555555')), `${JSON.stringify({ payload: PLACEHOLDERS[0] })}\n`);
    fs.writeFileSync(path.join(expected.folder, 'rollout-2026-10-15T23-59-59-not-a-uuid.jsonl'), '');
    fs.mkdirSync(path.join(expected.folder, nameAt('2026-10-15', '23-59-58', 'bbbbbbbb-2222-4333-8444-555555555555')));
    for (const date of ['2027-01-01', '2026-12-01', '2026-10-16']) {
      fs.mkdirSync(path.join(codexHome, 'sessions', ...date.split('-')), { recursive: true });
    }
    const row = sessionLogCheck({ codexHome, now });
    assert.equal(row.status, 'ok');
    assert.ok(row.value.startsWith(`recognized: ${expected.name},`));
    noPayload(row);
  });
});

test('newest-first lookup does not list older branches or recursively follow unrelated folders', async (t) => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    const expected = writeRollout(codexHome);
    writeRollout(codexHome, '2025-12-31');
    writeRollout(codexHome, '2026-09-30');
    writeRollout(codexHome, '2026-10-14');
    const sessions = path.join(codexHome, 'sessions');
    fs.mkdirSync(path.join(sessions, 'unrelated', '2099', '12', '31'), { recursive: true });
    const allowed = new Set([
      sessions, path.join(sessions, '2026'), path.join(sessions, '2026', '10'), expected.folder,
    ]);
    const readdir = fs.readdirSync;
    const listed = [];
    const spy = t.mock.method(fs, 'readdirSync', (folder, options) => {
      assert.ok(allowed.has(folder), `unexpected directory listing: ${folder}`);
      assert.ok(!options?.recursive);
      listed.push(folder);
      return readdir(folder, options);
    });
    try {
      const row = sessionLogCheck({ codexHome, now });
      assert.equal(row.status, 'ok');
      assert.deepEqual(new Set(listed), allowed);
    } finally {
      spy.mock.restore();
    }
  });
});

test('a broken envelope warns with the violated reader rule and recovery consequence', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    const invalid = records();
    invalid[1].ordinal = PLACEHOLDERS[0];
    writeRollout(codexHome, undefined, undefined, `${invalid.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const row = sessionLogCheck({ codexHome, now });
    assert.deepEqual(row, {
      key: 'sessionLog', status: 'warn',
      value: "format not recognized: Envelope requires timestamp, numeric ordinal, type and object payload at line 2; automatic recovery will treat this host's session logs as unknown evidence",
    });
    noPayload(row);
  });
});

test('no sessions folder warns that the host has no Codex session log yet', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    assert.deepEqual(sessionLogCheck({ codexHome, now }), {
      key: 'sessionLog', status: 'warn', value: 'no Codex session log on this host yet',
    });
  });
});

test('date folders without a matching rollout also warn that no log exists', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    fs.mkdirSync(path.join(codexHome, 'sessions', '2026', '10', '15'), { recursive: true });
    assert.deepEqual(sessionLogCheck({ codexHome, now }), {
      key: 'sessionLog', status: 'warn', value: 'no Codex session log on this host yet',
    });
  });
});

test('unknown record kinds stay ok and are reported without payload strings', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    const changed = records();
    changed[1].type = 'future_record_kind';
    writeRollout(codexHome, undefined, undefined, `${changed.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const row = sessionLogCheck({ codexHome, now });
    assert.equal(row.status, 'ok');
    assert.ok(row.value.includes(`2 records, last future_record_kind at ${TIME}`));
    assert.ok(row.value.endsWith('; new record kinds: future_record_kind'));
    noPayload(row);
  });
});

for (const tail of ['', `{"message":"${PLACEHOLDERS[0]}`]) {
  test(`a live ${tail ? 'partial' : 'unterminated complete'} last line stays ok with a writing notice`, async () => {
    await withTempTree('doctor-session-log-', (codexHome) => {
      const source = records().map((record) => JSON.stringify(record)).join('\n');
      const { name } = writeRollout(codexHome, undefined, undefined, tail ? `${source}\n${tail}` : source);
      const row = sessionLogCheck({ codexHome, now });
      assert.deepEqual(row, {
        key: 'sessionLog', status: 'ok',
        value: `recognized: ${name}, 2 records, last event_msg/user_message at ${TIME}; last line still being written`,
      });
      noPayload(row);
    });
  });
}

test('an empty rollout warns without failing doctor', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    const { name } = writeRollout(codexHome, undefined, undefined, '');
    assert.deepEqual(sessionLogCheck({ codexHome, now }), {
      key: 'sessionLog', status: 'warn', value: `empty Codex session log: ${name}`,
    });
  });
});

test('an unreadable rollout warns with the reader reason', async (t) => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    const { file } = writeRollout(codexHome);
    const readFile = fs.readFileSync;
    const spy = t.mock.method(fs, 'readFileSync', (target, ...args) => {
      if (target === file) throw Object.assign(new Error('EACCES: session log access denied'), { code: 'EACCES' });
      return readFile(target, ...args);
    });
    try {
      assert.deepEqual(sessionLogCheck({ codexHome, now }), {
        key: 'sessionLog', status: 'warn', value: 'EACCES: session log access denied',
      });
    } finally {
      spy.mock.restore();
    }
  });
});

test('unreadable session directory listings warn rather than aborting doctor', async () => {
  await withTempTree('doctor-session-log-', (codexHome) => {
    fs.writeFileSync(path.join(codexHome, 'sessions'), '');
    const row = sessionLogCheck({ codexHome, now });
    assert.equal(row.key, 'sessionLog');
    assert.equal(row.status, 'warn');
    assert.match(row.value, /ENOTDIR/);
  });
});
