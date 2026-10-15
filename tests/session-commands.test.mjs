/** Plan_80 A5/E12: command lifecycle and silence use synthetic session records only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, mock } from 'node:test';
import { readSessionActivity, silenceAgeMs } from '../src/home/lib/codex-session-log.mjs';
import { withTempTree } from './temp-tree.mjs';

const THREAD = '00000000-0000-4000-8000-000000000001';
const START = '2026-01-01T10:00:00.000Z';
const at = (seconds) => new Date(Date.parse(START) + seconds * 1000).toISOString();
const record = (seconds, type, payload = {}) => ({
  timestamp: at(seconds), ordinal: seconds + 1, type,
  payload: { text: '<private-message>', ...payload },
});
const meta = () => record(0, 'session_meta', { id: THREAD });
const call = (seconds, id, name = 'exec', type = 'custom_tool_call') =>
  record(seconds, 'response_item', { type, call_id: id, name, input: '<private-command>' });
const output = (seconds, id, type = 'custom_tool_call_output') =>
  record(seconds, 'response_item', { type, call_id: id, output: '<private-output>' });
const jsonl = (records) => records.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

function fixture(home, content) {
  const day = new Date(START);
  const folder = path.join(home, 'sessions', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-01-01T10-00-00-${THREAD}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

function read(home, options = {}) {
  const result = readSessionActivity({
    threadId: THREAD, startedAt: START, codexHome: home, referenceAt: at(20), ...options,
  });
  assert.doesNotMatch(JSON.stringify(result), /<private-(?:message|command|output)>/);
  return result;
}

const pending = (id, seconds) => ({ call_id: id, name: 'exec', called_at: at(seconds) });
const unknown = (reason) => ({ state: 'unknown', reason, pending: [] });

test('a later output cannot close the command at reference; raw activity still includes it', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(10, 'a'), output(30, 'a')]));
    const result = read(home);
    assert.equal(result.state, 'observed');
    assert.equal(result.records, 3);
    assert.equal(result.last_record_at, at(30));
    assert.equal(result.last_record_kind, 'response_item/custom_tool_call_output');
    assert.deepEqual(result.at_reference, {
      as_of: at(20), last_record_at: at(10), last_record_kind: 'response_item/custom_tool_call',
      records: 2, commands: { state: 'in-flight', reason: null, pending: [pending('a', 10)] },
    });
    assert.deepEqual(silenceAgeMs(result.at_reference, at(20)), { ms: 10000, reason: null });
  });
});

test('interleaved custom and function calls close only the matching call_id', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(1, 'a'), call(2, 'b', 'exec', 'function_call'), output(3, 'a')]));
    assert.deepEqual(read(home).at_reference.commands,
      { state: 'in-flight', reason: null, pending: [pending('b', 2)] });
  });
});

test('all matched calls closed at the exact reference boundary means none', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(1, 'a'), call(2, 'b', 'exec', 'function_call'),
      output(3, 'a'), output(20, 'b', 'function_call_output')]));
    const reference = read(home).at_reference;
    assert.equal(reference.records, 5);
    assert.equal(reference.last_record_at, at(20));
    assert.deepEqual(reference.commands, { state: 'none', reason: null, pending: [] });
    assert.deepEqual(silenceAgeMs(reference, at(20)), { ms: 0, reason: null });
  });
});

for (const type of ['custom_tool_call_output', 'function_call_output']) {
  test(`${type} without an earlier call is unknown`, async () => {
    await withTempTree('session-commands-', (home) => {
      fixture(home, jsonl([meta(), output(1, 'orphan', type)]));
      const result = read(home);
      assert.deepEqual(result.at_reference.commands, unknown('orphan tool output'));
      assert.equal(result.longest_quiet_gap_ms, null);
    });
  });
}

for (const type of ['custom_tool_call', 'function_call', 'custom_tool_call_output', 'function_call_output']) {
  for (const id of [undefined, null, 42]) {
    test(`${type} with ${String(id)} call_id cannot establish none`, async () => {
      await withTempTree('session-commands-', (home) => {
        fixture(home, jsonl([meta(), record(1, 'response_item', { type, call_id: id, name: 'exec' })]));
        const result = read(home);
        assert.deepEqual(result.at_reference.commands, unknown('tool record missing string call_id'));
        assert.equal(result.longest_quiet_gap_ms, null);
      });
    });
  }
}

test('even a closed wait makes asynchronous command lifecycle unknown', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(1, 'a'), output(2, 'a'),
      call(3, 'w', 'wait', 'function_call'), output(4, 'w', 'function_call_output')]));
    const result = read(home);
    assert.deepEqual(result.at_reference.commands, unknown('asynchronous command lifecycle'));
    assert.equal(result.longest_quiet_gap_ms, null);
    // E12: lifecycle uncertainty does not erase a valid session-log activity timestamp.
    assert.deepEqual(silenceAgeMs(result.at_reference, at(20)), { ms: 16000, reason: null });
  });
});

for (const name of ['request_user_input_async', 'sleep', undefined]) {
  test(`an open ${String(name)} tool is unknown and names the tool`, async () => {
    await withTempTree('session-commands-', (home) => {
      fixture(home, jsonl([meta(), record(1, 'response_item',
        { type: 'custom_tool_call', call_id: 'a', name, namespace: 'clock' })]));
      const result = read(home);
      assert.deepEqual(result.at_reference.commands, unknown(`open tool ${name ?? 'unknown'}`));
      assert.equal(result.longest_quiet_gap_ms, null);
    });
  });
}

test('a completed non-exec tool permits none and quiet gaps only outside its lifetime', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(1, 's', 'sleep'), output(10, 's'), record(12, 'turn_context')]));
    const result = read(home);
    assert.deepEqual(result.at_reference.commands, { state: 'none', reason: null, pending: [] });
    assert.equal(result.longest_gap_ms, 9000);
    assert.equal(result.longest_quiet_gap_ms, 2000);
  });
});

for (const state of ['not-observed', 'missing', 'unreadable', 'empty', 'unrecognized', 'incomplete']) {
  test(`session ${state} cannot claim command absence or silence`, async () => {
    await withTempTree('session-commands-', (home) => {
      let spy;
      if (state === 'unreadable') {
        const file = fixture(home, jsonl([meta()]));
        const original = fs.readFileSync;
        spy = mock.method(fs, 'readFileSync', function (filePath, ...args) {
          if (filePath === file) throw new Error('synthetic read failure');
          return original.call(this, filePath, ...args);
        });
      } else if (state === 'empty') fixture(home, '');
      else if (state === 'unrecognized') fixture(home, jsonl([meta(), { invalid: true }]));
      else if (state === 'incomplete') fixture(home, jsonl([meta(), record(1, 'turn_context')]) + '{');
      try {
        const result = read(home, state === 'not-observed' ? { threadId: null } : {});
        assert.equal(result.state, state);
        assert.deepEqual(result.at_reference.commands, unknown(`session ${state}`));
        assert.equal(result.longest_quiet_gap_ms, null);
        assert.deepEqual(silenceAgeMs(result.at_reference, at(20)),
          { ms: null, reason: `session evidence ${state}` });
      } finally { spy?.mock.restore(); }
    });
  });
}

test('future wait and malformed command evidence do not contaminate the reference snapshot', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), record(10, 'event_msg', { type: 'token_count' }),
      call(30, 'w', 'wait'), output(40, undefined)]));
    const result = read(home);
    assert.equal(result.records, 4);
    assert.equal(result.last_record_at, at(40));
    assert.equal(result.at_reference.records, 2);
    assert.equal(result.at_reference.last_record_at, at(10));
    assert.deepEqual(result.at_reference.commands, { state: 'none', reason: null, pending: [] });
    assert.equal(result.longest_quiet_gap_ms, null);
  });
});

test('longest quiet gap excludes pauses inside either interleaved open call', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(2, 'a'), call(3, 'b'), output(103, 'a'),
      record(153, 'turn_context'), output(203, 'b'), record(210, 'event_msg', { type: 'token_count' })]));
    const result = read(home, { referenceAt: at(210) });
    assert.equal(result.longest_gap_ms, 100000);
    assert.equal(result.longest_quiet_gap_ms, 7000);
    assert.deepEqual(result.at_reference.commands, { state: 'none', reason: null, pending: [] });
  });
});

test('an open exec still permits quiet-gap evidence from before the call started', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(2, 'a'), record(102, 'turn_context')]));
    const result = read(home, { referenceAt: at(102) });
    assert.equal(result.longest_gap_ms, 100000);
    assert.equal(result.longest_quiet_gap_ms, 2000);
    assert.equal(result.at_reference.commands.state, 'in-flight');
  });
});

test('fewer than two records has null gaps and an absent reference stays null', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta()]));
    const result = read(home, { referenceAt: undefined });
    assert.equal(result.longest_gap_ms, null);
    assert.equal(result.longest_quiet_gap_ms, null);
    assert.equal(result.at_reference, null);
  });
});

test('no records before reference has null activity and silence, with checked command absence', async () => {
  await withTempTree('session-commands-', (home) => {
    fixture(home, jsonl([meta(), call(1, 'a')]));
    const result = read(home, { referenceAt: at(-1) });
    assert.deepEqual(result.at_reference, {
      as_of: at(-1), last_record_at: null, last_record_kind: null, records: 0,
      commands: { state: 'none', reason: null, pending: [] },
    });
    assert.deepEqual(silenceAgeMs(result.at_reference, at(-1)),
      { ms: null, reason: 'no session record before reference' });
  });
});

for (const referenceAt of ['invalid', '', null, 123]) {
  test(`invalid reference ${JSON.stringify(referenceAt)} has unknown commands and null times`, async () => {
    await withTempTree('session-commands-', (home) => {
      fixture(home, jsonl([meta(), call(1, 'a')]));
      const result = read(home, { referenceAt });
      assert.equal(result.state, 'observed');
      assert.deepEqual(result.at_reference, {
        as_of: null, last_record_at: null, last_record_kind: null, records: 0,
        commands: unknown('reference time invalid'),
      });
      assert.deepEqual(silenceAgeMs(result.at_reference, referenceAt),
        { ms: null, reason: 'reference time invalid' });
    });
  });
}

test('silence handles missing, invalid, future and exact-boundary last records without I/O', () => {
  const spy = mock.method(fs, 'readFileSync', () => { throw new Error('unexpected read'); });
  try {
    for (const reference of [null, undefined, {}, { last_record_at: 'invalid' },
      { last_record_at: at(21) }]) {
      assert.deepEqual(silenceAgeMs(reference, at(20)),
        { ms: null, reason: 'no session record before reference' });
    }
    assert.deepEqual(silenceAgeMs({ last_record_at: at(20) }, at(20)), { ms: 0, reason: null });
    assert.deepEqual(silenceAgeMs({ last_record_at: at(19.999) }, at(20)), { ms: 1, reason: null });
    assert.deepEqual(silenceAgeMs(null, undefined), { ms: null, reason: 'reference time invalid' });
    assert.equal(spy.mock.callCount(), 0);
  } finally { spy.mock.restore(); }
});
