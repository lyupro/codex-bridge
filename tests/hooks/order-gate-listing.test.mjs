/** OW-071 S2: proven dispatcher absence must refuse before host failure or fallback spends quota. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { decodeDenial, runGate } from './order-gate-fixtures.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';

const restartRow = orderDiagnosticMessage('next-action', { variant: 'restart-window' });

function listingFixture(name, initialOnly = false) {
  const root = makeTempTree('order-gate-listing-');
  const entries = fs.readFileSync(new URL(`../meta/fixtures/${name}`, import.meta.url), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const initialIndex = entries.findIndex((entry) => entry.attachment?.isInitial === true);
  assert.ok(initialIndex >= 0);
  const initial = entries[initialIndex];
  const transcriptPath = path.join(root, 'transcript.jsonl');
  const selected = initialOnly ? entries.slice(0, initialIndex + 1) : entries;
  fs.writeFileSync(transcriptPath, selected.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return {
    root, transcriptPath, initial,
    input: {
      tool_name: 'Agent',
      session_id: initial.sessionId,
      transcript_path: transcriptPath,
      tool_input: { subagent_type: 'codex-build', prompt: 'fixture order' },
    },
  };
}

function invoke({ root, input }) {
  const result = runGate(root, JSON.stringify(input));
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const late = 'claude-2.1.304-agent-listing-late.jsonl';
const healthy = 'claude-2.1.310-agent-listing-healthy.jsonl';

for (const withModel of [false, true]) {
  test(`initial late listing denies with restart-window${withModel ? ' before the model check' : ''}`, () => {
    const fixture = listingFixture(late, true);
    if (withModel) fixture.input.tool_input.model = 'fixture-model';
    const decision = decodeDenial(invoke(fixture), 'restart-window');
    const reason = decision.permissionDecisionReason;
    assert.match(reason, /dispatcher codex-build/);
    assert.match(reason, /replayed from its transcript, 1 listing records/);
    assert.ok(reason.includes(`last at ${fixture.initial.timestamp}`));
    assert.match(reason, /The host would fail the call with "Agent type not found"/);
    assert.equal(reason.split('\n').at(-1), restartRow);
    assert.deepEqual(reason.split('\n').filter((line) => line.startsWith('Action: ')), [restartRow]);
  });
}

for (const [label, name] of [['full late listing', late], ['healthy listing', healthy]]) {
  test(`${label} does not refuse with restart-window`, () => {
    assert.equal(invoke(listingFixture(name)).includes(restartRow), false);
  });
}

for (const [label, change] of [
  ['missing session_id', (input) => { delete input.session_id; }],
  ['missing transcript_path', (input) => { delete input.transcript_path; }],
  ['empty session_id', (input) => { input.session_id = ' '; }],
  ['empty transcript_path', (input) => { input.transcript_path = ' '; }],
  ['non-string session_id', (input) => { input.session_id = 42; }],
  ['non-string transcript_path', (input) => { input.transcript_path = 42; }],
  ['nonexistent transcript', (input) => { input.transcript_path += '.missing'; }],
  ['session absent from transcript', (input) => { input.session_id = 'absent-session'; }],
]) {
  test(`${label} does not refuse with restart-window`, () => {
    const fixture = listingFixture(late, true);
    change(fixture.input);
    assert.equal(invoke(fixture).includes(restartRow), false);
  });
}

test('non-dispatcher passes untouched despite the initial late listing', () => {
  const fixture = listingFixture(late, true);
  fixture.input.tool_input.subagent_type = 'general-purpose';
  assert.equal(invoke(fixture), '');
});
