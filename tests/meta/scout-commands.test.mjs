/** Guards execution facts after the 2026-09-16 scout OK on a dead sandbox (Plan_57 D3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, collect } from '../../src/home/lib/write-meta.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from './test-fixtures.mjs';

const noCommands = [
  { type: 'thread.started', thread_id: 'scout-commands' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Analysis follows.' } },
];
const startedCommand = {
  ...COMPLETED_COMMAND,
  type: 'item.started',
  item: { ...COMPLETED_COMMAND.item, aggregated_output: '', exit_code: null, status: 'in_progress' },
};
const failedCommand = {
  ...COMPLETED_COMMAND,
  item: {
    ...COMPLETED_COMMAND.item,
    command: 'rg missing src/example.mjs',
    aggregated_output: '',
    exit_code: 1,
    status: 'failed',
  },
};
const questions = [{ id: 'Q1', text: 'How is the configuration loaded?' }];
const scoutResult = {
  answer: 'The configuration loader validates values before returning them to the caller.',
  answers: [{
    question_id: 'Q1',
    answer: 'The loader reads the configuration from disk, validates each required value, and returns '
      + 'the parsed settings. Invalid values produce a diagnostic that names the setting to correct.',
    // Nonempty evidence accepted the incident run even though it described a sandbox refusal.
    evidence: ['The requested source files were not readable because the sandbox rejected commands.'],
  }],
  findings: [],
  unknowns: [],
  report_markdown: '# Configuration loading',
};
const noCommandReason = 'scout executed no command, so no answer rests on reading the code; '
  + 'check stderr.log for sandbox refusals before changing the order';

// Keep this shape guard first: a changed CLI event contract must fail at the stream boundary.
test('readEvents counts the real codex-cli 0.154.0 completed command_execution shape', () => {
  const cases = [
    ['completed', [COMPLETED_COMMAND], 1],
    ['failed', [failedCommand], 1],
    ['started only', [startedCommand], 0],
    ['started and completed with the same id', [startedCommand, COMPLETED_COMMAND], 1],
    ['two completed events', [COMPLETED_COMMAND, failedCommand], 2],
    ['messages only', noCommands, 0],
    ['other event type', [{ ...COMPLETED_COMMAND, type: 'item.updated' }], 0],
    ['other item type', [{
      ...COMPLETED_COMMAND, item: { ...COMPLETED_COMMAND.item, type: 'agent_message' },
    }], 0],
    ['missing or null item', [{ type: 'item.completed' }, { type: 'item.completed', item: null }], 0],
  ];
  for (const [label, events, expected] of cases) {
    assert.equal(readEvents(makeRun({ events })).commands_executed, expected, label);
  }
});

test('readEvents counts completed command items regardless of status or exit_code', () => {
  for (const [status, exit_code] of [['failed', 127], ['in_progress', null], ['unknown', -1], [undefined, undefined]]) {
    const events = [{
      ...COMPLETED_COMMAND, item: { ...COMPLETED_COMMAND.item, status, exit_code },
    }];
    assert.equal(readEvents(makeRun({ events })).commands_executed, 1, `${status}/${exit_code}`);
  }
});

test('readEvents reports zero executed commands for empty or absent streams', () => {
  for (const events of [[], null]) {
    assert.equal(readEvents(makeRun({ events })).commands_executed, 0);
  }
});

test('a fully covered scout with messages but no commands fails and starts its reply with FAIL', () => {
  const dir = makeRun({
    args: ['exec', '--json'], events: noCommands, result: scoutResult, questions,
  });

  const { meta, reply } = collect(dir, 'codex-scout', 0);

  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, noCommandReason);
  assert.ok(meta.reason.length <= 170);
  assert.ok(reply.startsWith(`FAIL — ${noCommandReason}`));
});

for (const command of [COMPLETED_COMMAND, failedCommand]) {
  test(`one completed command with status ${command.item.status} and exit ${command.item.exit_code} allows scout OK`, () => {
    const dir = makeRun({
      args: ['exec', '--json'], events: [...noCommands, command], result: scoutResult, questions,
    });

    const { meta, reply } = collect(dir, 'codex-scout', 0);

    assert.equal(meta.status, 'OK', meta.reason);
    assert.ok(reply.startsWith('OK —'));
  });
}

test('a started command without a completed item does not allow scout OK', () => {
  const dir = makeRun({
    args: ['exec', '--json'], events: [...noCommands, startedCommand], result: scoutResult, questions,
  });

  const { meta } = collect(dir, 'codex-scout', 0);

  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, noCommandReason);
});

test('missing commands take precedence over unanswered scout questions', () => {
  const dir = makeRun({
    args: ['exec', '--json'], events: noCommands,
    result: { ...scoutResult, answers: [] }, questions,
  });

  const { meta } = collect(dir, 'codex-scout', 0);

  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, noCommandReason);
});

// Recomputing an archived run must not accuse it of a contract it never had: no stream, no gate.
test('an archived scout run without an events stream is not judged by the command gate', () => {
  const dir = makeRun({ result: scoutResult, questions });

  assert.equal(readEvents(dir).hasStream, false);
  const { meta } = collect(dir, 'codex-scout', 0);

  assert.notEqual(meta.reason, noCommandReason);
  assert.equal(meta.status, 'OK', meta.reason);
});

for (const [agent, result] of [
  ['codex-build', buildResult([])],
  ['codex-review', { verdict: 'approve', summary: 'Reviewed', findings: [], next_steps: [] }],
]) {
  test(`${agent} remains OK without any executed command`, () => {
    const dir = makeRun({
      args: ['exec', '--json'], events: noCommands, result, file: AGENTS[agent].result,
    });

    assert.equal(readEvents(dir).commands_executed, 0);
    const { meta } = collect(dir, agent, 0);

    assert.equal(meta.status, 'OK', meta.reason);
  });
}
