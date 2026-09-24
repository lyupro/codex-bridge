import assert from 'node:assert/strict';
import test from 'node:test';
import { DISPATCHER_CONTRACTS, dispatcherContractStatus, judgeDispatcherContracts } from '../../cli/dispatcher-contract.mjs';

const okCommand = "node -e console.log('PROBE-OK-OUT')";
const failCommand = "node -e console.log('PROBE-FAIL-OUT'); process.exit(2)";
const agentType = 'probe-agent';
const promptToken = 'caller prompt token';

function realJournalFixture() {
  const payload = (command, more = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...more });
  return [
    { event: 'PreToolUse', payload: { agent_type: agentType, agent_id: 'a4d79407ef9aab270' }, transcript: {
      path: 'agent-a4d79407ef9aab270.jsonl',
      firstLine: JSON.stringify({ type: 'user', message: { content: promptToken } }),
    } },
    { event: 'PreToolUse', payload: payload(okCommand, { agent_type: agentType, agent_id: 'a4d79407ef9aab270' }) },
    { event: 'PostToolUse', payload: payload(okCommand, { tool_response: { stdout: 'PROBE-OK-OUT' } }) },
    { event: 'PreToolUse', payload: payload(failCommand, { agent_type: agentType, agent_id: 'a4d79407ef9aab270' }) },
    { event: 'PostToolUseFailure', payload: payload(failCommand, { agent_type: agentType, error: 'Exit code 2\nPROBE-FAIL-OUT\nPROBE-FAIL-ERR' }) },
  ];
}

function judge(entries = realJournalFixture(), hostHealthy = true) {
  return judgeDispatcherContracts({ entries, hostHealthy, okCommand, failCommand,
    okOutput: 'PROBE-OK-OUT', failOutput: 'PROBE-FAIL-OUT', agentType, promptToken });
}

test('real host journal fixture honors all dispatcher contracts', () => {
  const result = judge();
  assert.deepEqual(Object.keys(result), DISPATCHER_CONTRACTS);
  for (const item of Object.values(result)) assert.equal(item.result, 'honored');
});

test('each dispatcher contract detects its specified regression', () => {
  const cases = [
    ['agentIdentity', (entries) => { entries[1].payload.agent_type = undefined; }],
    ['shellStdout', (entries) => { entries[2].payload.tool_response.stdout = 'missing'; }],
    ['shellFailure', (entries) => { entries.push({ event: 'PostToolUse', payload: { tool_input: { command: failCommand } } }); }],
    ['agentTranscript', (entries) => {
      entries[0].transcript = { path: 'agent.jsonl', error: 'ENOENT' };
    }],
  ];
  for (const [name, mutate] of cases) {
    const entries = realJournalFixture(); mutate(entries);
    assert.equal(judge(entries)[name].result, 'changed', name);
  }
});

test('parent-only journals are inconclusive for command contracts', () => {
  const result = judge([{ event: 'PreToolUse', payload: { tool_input: { command: 'parent-only' } } }]);
  for (const name of ['agentIdentity', 'shellStdout', 'shellFailure']) assert.equal(result[name].result, 'inconclusive');
  assert.equal(result.agentTranscript.result, 'inconclusive');
});

test('an unhealthy host makes every contract inconclusive', () => {
  for (const item of Object.values(judge(realJournalFixture(), false))) assert.equal(item.result, 'inconclusive');
});

test('dispatcher status exposes all five states', () => {
  const entries = dispatcherContractStatus({ record: null, version: '2.1.281' });
  assert.ok(entries.every((entry) => entry.state === 'unverified'));
  assert.ok(dispatcherContractStatus({ record: null, version: null }).every((entry) => entry.state === 'unknown-host'));
  const record = { contracts: Object.fromEntries(DISPATCHER_CONTRACTS.map((name) => [name, { result: 'honored', version: '2.1.281' }])) };
  assert.ok(dispatcherContractStatus({ record, version: '2.1.281' }).every((entry) => entry.state === 'verified'));
  assert.ok(dispatcherContractStatus({ record, version: '2.1.282' }).every((entry) => entry.state === 'stale'));
  record.contracts.agentIdentity.result = 'changed';
  const changed = dispatcherContractStatus({ record, version: '2.1.281' })[0];
  assert.equal(changed.state, 'changed');
  assert.match(changed.message, /cannot be trusted.*Plan_62 D19/);
});
