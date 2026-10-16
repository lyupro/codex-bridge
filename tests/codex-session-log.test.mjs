import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, mock } from 'node:test';
import { readSessionActivity } from '../src/home/lib/codex-session-log.mjs';
import { buildStopRecord } from '../src/home/lib/runner/stop-record.mjs';
import { withTempTree } from './temp-tree.mjs';

const THREAD = '00000000-0000-4000-8000-000000000001';
const START = new Date(2026, 0, 1, 12).toISOString();
const FIRST = '2026-01-01T10:00:00.000Z';
const LAST = '2026-01-01T10:02:00.000Z';
const SAMPLED = '2026-01-01T11:00:00.000Z';
const PLACEHOLDERS = ['<text>', '<metadata>', '<private>', '<name>'];
const record = (type, payload = {}, timestamp = FIRST, ordinal = 1) => ({
  timestamp, ordinal, type, payload: { text: '<text>', private: '<private>', ...payload },
  metadata: { name: '<name>', text: '<metadata>' },
});
const meta = () => record('session_meta', { id: THREAD });
const jsonl = (records) => records.map((value) => JSON.stringify(value)).join('\n') + '\n';

function fixture(home, content, offset = 0) {
  const day = new Date(START);
  day.setDate(day.getDate() + offset);
  const year = String(day.getFullYear());
  const month = String(day.getMonth() + 1).padStart(2, '0');
  const date = String(day.getDate()).padStart(2, '0');
  const folder = path.join(home, 'sessions', year, month, date);
  fs.mkdirSync(folder, { recursive: true });
  const file = `rollout-${year}-${month}-${date}T12-00-00-${THREAD}.jsonl`;
  const fullPath = path.join(folder, file);
  fs.writeFileSync(fullPath, content);
  return { file, fullPath, folder };
}

function read(home, options = {}) {
  const result = readSessionActivity({
    threadId: THREAD, startedAt: START, codexHome: home, now: () => new Date(SAMPLED), ...options,
  });
  for (const text of PLACEHOLDERS) assert.ok(!JSON.stringify(result).includes(text));
  assert.equal(result.sampled_at, SAMPLED);
  assert.deepEqual(Object.keys(result).sort(), [
    'state', 'reason', 'file', 'last_record_at', 'last_record_kind', 'records', 'unknown_kinds', 'sampled_at',
    'longest_gap_ms', 'longest_quiet_gap_ms', 'at_reference', 'sandbox_witness',
  ].sort());
  return result;
}

test('healthy activity counts reasoning and the final token_count; it never uses sampling or mtime', async () => {
  await withTempTree('session-log-', (home) => {
    const content = jsonl([meta(), record('response_item', { type: 'reasoning' }),
      record('event_msg', { type: 'token_count' }, LAST, 3)]);
    const { file, fullPath, folder } = fixture(home, content);
    fs.utimesSync(fullPath, new Date(SAMPLED), new Date(SAMPLED));
    const before = fs.statSync(fullPath).mtimeMs;
    const result = read(home);
    assert.deepEqual(result, {
      state: 'observed', reason: null, file, last_record_at: LAST,
      last_record_kind: 'event_msg/token_count', records: 3, unknown_kinds: [], sampled_at: SAMPLED,
      longest_gap_ms: 120000, longest_quiet_gap_ms: 120000, at_reference: null,
      sandbox_witness: { state: 'absent', policy: null, at: null },
    });
    assert.notEqual(result.last_record_at, result.sampled_at);
    assert.notEqual(Date.parse(result.last_record_at), before);
    assert.equal(fs.readFileSync(fullPath, 'utf8'), content);
    assert.equal(fs.statSync(fullPath).mtimeMs, before);
    assert.deepEqual(fs.readdirSync(folder), [file]);
  });
});

test('stalled activity ends with reasoning after item_completed', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta(), record('event_msg', { type: 'item_completed' }),
      record('response_item', { type: 'reasoning' }, LAST)]));
    const result = read(home);
    assert.equal(result.state, 'observed');
    assert.equal(result.last_record_at, LAST);
    assert.equal(result.last_record_kind, 'response_item/reasoning');
    assert.equal(result.records, 3);
  });
});

test('no thread id is not-observed and never reads the filesystem or needs a start time', async () => {
  await withTempTree('session-log-', (home) => {
    const spy = mock.method(fs, 'readdirSync', () => { throw new Error('unexpected read'); });
    try {
      const result = read(home, { threadId: null, startedAt: undefined });
      assert.equal(result.state, 'not-observed');
      assert.equal(result.file, null);
      assert.equal(result.last_record_at, null);
      assert.equal(result.last_record_kind, null);
      assert.equal(spy.mock.callCount(), 0);
    } finally { spy.mock.restore(); }
  });
});

// Plan_80 O9a: a resume appends to the thread's original day, so a far day is found by the store
// fallback; a store without this thread still reads missing.
test('a thread two days away is found by the store fallback; another thread there stays missing', async () => {
  await withTempTree('session-log-', (home) => {
    const { file } = fixture(home, jsonl([meta()]), 2);
    assert.equal(read(home).state, 'observed');
    assert.equal(read(home).file, file);
    const result = read(home, { threadId: '00000000-0000-4000-8000-000000000002' });
    assert.equal(result.state, 'missing');
    assert.equal(result.file, null);
    assert.equal(result.records, 0);
    assert.equal(result.last_record_at, null);
    assert.equal(result.last_record_kind, null);
  });
});

for (const offset of [-1, 1]) {
  test(`finds the rollout in the neighboring local day (${offset})`, async () => {
    await withTempTree('session-log-', (home) => {
      const { file } = fixture(home, jsonl([meta()]), offset);
      const result = read(home);
      assert.equal(result.state, 'observed');
      assert.equal(result.file, file);
      assert.equal(path.basename(result.file), result.file);
    });
  });
}

test('a different thread file does not match', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta()]));
    assert.equal(read(home, { threadId: '00000000-0000-4000-8000-000000000002' }).state, 'missing');
  });
});

test('unreadable preserves the filesystem error message and file name, not activity', async () => {
  await withTempTree('session-log-', (home) => {
    const { file, fullPath } = fixture(home, jsonl([meta()]));
    const original = fs.readFileSync;
    const spy = mock.method(fs, 'readFileSync', function (filePath, ...args) {
      if (filePath === fullPath) throw new Error('synthetic read failure');
      return original.call(this, filePath, ...args);
    });
    try {
      const result = read(home);
      assert.equal(result.state, 'unreadable');
      assert.equal(result.reason, 'synthetic read failure');
      assert.equal(result.file, file);
      assert.equal(result.last_record_at, null);
      assert.equal(result.last_record_kind, null);
    } finally { spy.mock.restore(); }
  });
});

test('an empty file is empty with no activity', async () => {
  await withTempTree('session-log-', (home) => {
    const { file } = fixture(home, '');
    const result = read(home);
    assert.equal(result.state, 'empty');
    assert.equal(result.file, file);
    assert.equal(result.records, 0);
    assert.equal(result.last_record_at, null);
    assert.equal(result.last_record_kind, null);
  });
});

const invalidCases = [
  ['non-final JSON', () => [meta(), '<text>', meta()].map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n', /JSON record.*line 2/],
  ['missing payload', () => { const r = record('event_msg'); delete r.payload; return jsonl([meta(), r]); }, /Envelope.*line 2/],
  ['non-object payload', () => jsonl([meta(), record('event_msg', {}, LAST), { ...meta(), payload: [] }]), /Envelope.*line 3/],
  ['missing ordinal', () => { const r = meta(); delete r.ordinal; return jsonl([r]); }, /Envelope.*line 1/],
  ['non-numeric ordinal', () => jsonl([{ ...meta(), ordinal: '<text>' }]), /Envelope.*line 1/],
  ['missing type', () => { const r = meta(); delete r.type; return jsonl([r]); }, /Envelope.*line 1/],
  ['non-object record', () => jsonl([meta(), []]), /Envelope.*line 2/],
  ['changed timestamp format', () => jsonl([meta(), record('event_msg', {}, '2026-01-01T10:00:00Z')]), /Timestamp.*line 2/],
  ['impossible timestamp', () => jsonl([record('event_msg', {}, '2026-02-30T10:00:00.000Z')]), /Timestamp.*line 1/],
  ['missing timestamp', () => { const r = meta(); delete r.timestamp; return jsonl([r]); }, /Envelope.*line 1/],
  ['mismatched first session_meta', () => jsonl([record('event_msg'), record('session_meta', { id: '<text>' })]), /First session_meta id.*line 2/],
  ['CRLF', () => jsonl([meta(), record('event_msg')]).replaceAll('\n', '\r\n'), /LF-only.*line 1/],
  ['non-final BOM', () => '\ufeff' + jsonl([meta(), record('event_msg')]), /BOM not allowed at line 1/],
];
for (const [label, content, reason] of invalidCases) {
  test(`${label} is unrecognized and never reuses earlier activity`, async () => {
    await withTempTree('session-log-', (home) => {
      fixture(home, content());
      const result = read(home);
      assert.equal(result.state, 'unrecognized');
      assert.match(result.reason, reason);
      assert.equal(result.last_record_at, null);
      assert.equal(result.last_record_kind, null);
    });
  });
}

for (const tail of ['{"payload":"<text>"', '{"payload":"<text>"\n']) {
  test(`a malformed last line is incomplete (${tail.endsWith('\n') ? 'terminated' : 'partial'})`, async () => {
    await withTempTree('session-log-', (home) => {
      fixture(home, jsonl([meta(), record('response_item', { type: 'reasoning' }, LAST)]) + tail);
      const result = read(home);
      assert.equal(result.state, 'incomplete');
      assert.equal(result.last_record_at, LAST);
      assert.equal(result.last_record_kind, 'response_item/reasoning');
      assert.equal(result.records, 2);
    });
  });
}

test('a valid final record without LF is incomplete and retains its valid activity', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta(), record('event_msg', { type: 'token_count' }, LAST)]).slice(0, -1));
    const result = read(home);
    assert.equal(result.state, 'incomplete');
    assert.equal(result.last_record_at, LAST);
    assert.equal(result.last_record_kind, 'event_msg/token_count');
    assert.equal(result.records, 2);
  });
});

test('a partial first line has no valid activity and is incomplete', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, '{');
    const result = read(home);
    assert.equal(result.state, 'incomplete');
    assert.equal(result.records, 0);
    assert.equal(result.last_record_at, null);
    assert.equal(result.last_record_kind, null);
  });
});

test('unknown kinds stay observed and are deduplicated; every known record kind counts', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta(), record('turn_context'), record('world_state'),
      record('token_usage_record'), record('future_record'), record('future_record', {}, LAST)]));
    const result = read(home);
    assert.equal(result.state, 'observed');
    assert.equal(result.records, 6);
    assert.deepEqual(result.unknown_kinds, ['future_record']);
    assert.equal(result.last_record_kind, 'future_record');
    assert.equal(result.last_record_at, LAST);
  });
});

test('only the first session_meta id is checked', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta(), record('session_meta', { id: '<text>' }, LAST)]));
    assert.equal(read(home).state, 'observed');
  });
});

test('an unknown start time is not-observed with a reason, never a throw or a guessed day', async () => {
  await withTempTree('session-log-', (home) => {
    for (const startedAt of [undefined, null, 'not a date']) {
      const result = read(home, { startedAt });
      assert.equal(result.state, 'not-observed');
      assert.equal(result.reason, 'run start time unknown');
      assert.equal(result.file, null);
      assert.equal(result.last_record_at, null);
    }
  });
});

test('stop record adds activity from thread.started and status started_at, preserving other fields', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta(), record('response_item', { type: 'reasoning' }, LAST)]), 1);
    const runDir = path.join(home, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ started_at: START }));
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), jsonl([{ type: 'thread.started', thread_id: THREAD }]));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const run = { stop: { trigger: 'deadline', exit_code: null }, receipts: { lines: 2 } };
      const result = buildStopRecord(run, runDir, 'codex-build');
      assert.equal(result.version, 2);
      assert.equal(result.trigger, 'deadline');
      assert.equal(result.exit_code, null);
      assert.deepEqual(result.receipts, run.receipts);
      assert.deepEqual(result.result_file, { state: 'missing' });
      assert.equal(result.session.state, 'observed');
      assert.equal(result.session.last_record_at, LAST);
      assert.equal(result.session.last_record_kind, 'response_item/reasoning');
      for (const text of PLACEHOLDERS) assert.ok(!JSON.stringify(result.session).includes(text));
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

test('stop record preserves result availability when no thread was observed', async () => {
  await withTempTree('session-log-', (runDir) => {
    const result = buildStopRecord({ stop: { trigger: 'spawn-error' }, receipts: null }, runDir, 'codex-build');
    assert.equal(result.trigger, 'spawn-error');
    assert.deepEqual(result.result_file, { state: 'missing' });
    assert.equal(result.session.state, 'not-observed');
    assert.equal(result.session.last_record_at, null);
  });
});

test('activity is the last record in file order, not the largest timestamp', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([record('session_meta', { id: THREAD }, LAST), record('world_state', {}, FIRST)]));
    const result = read(home);
    assert.equal(result.state, 'observed');
    assert.equal(result.last_record_at, FIRST);
    assert.equal(result.last_record_kind, 'world_state');
  });
});

test('an invalid earlier record wins over an incomplete final line', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta(), { ...meta(), payload: null }]) + '{');
    const result = read(home);
    assert.equal(result.state, 'unrecognized');
    assert.match(result.reason, /Envelope.*line 2/);
    assert.equal(result.last_record_at, null);
  });
});

test('discovery failures and read TypeErrors are unreadable, not silence or thrown errors', async () => {
  await withTempTree('session-log-', (home) => {
    fixture(home, jsonl([meta()]));
    for (const method of ['readdirSync', 'readFileSync']) {
      const spy = mock.method(fs, method, () => { throw new TypeError('synthetic filesystem failure'); });
      try {
        const result = read(home);
        assert.equal(result.state, 'unreadable');
        assert.equal(result.reason, 'synthetic filesystem failure');
        assert.equal(result.last_record_at, null);
        assert.equal(result.last_record_kind, null);
      } finally { spy.mock.restore(); }
    }
  });
});
