/** Verifies the real-host refusal probe without ever spawning Claude Code. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hostContractPath, readHostContract } from '../../cli/host-contract.mjs';
import { readDispatcherContract } from '../../cli/dispatcher-contract-record.mjs';
import { PROBE_MARKER, judgeProbe, probeContract } from '../../cli/probe-contract.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

test('judgeProbe reports a marker as an ignored refusal', () => {
  assert.deepEqual(judgeProbe({
    markerExists: true,
    hookFired: true,
    hostResult: { status: 0 },
  }).result, 'ignored');
});

test('judgeProbe reports honored only after the hook fired and a clean host exit', () => {
  assert.equal(judgeProbe({
    markerExists: false,
    hookFired: true,
    hostResult: { status: 0 },
  }).result, 'honored');
});

test('judgeProbe keeps every unmeasured outcome inconclusive', () => {
  const cases = [
    { name: 'host missing', input: { markerExists: false, hookFired: false, hostResult: null } },
    { name: 'non-zero exit', input: { markerExists: false, hookFired: true, hostResult: { status: 1 } } },
    { name: 'timeout', input: { markerExists: false, hookFired: true, hostResult: { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) } } },
    { name: 'signal', input: { markerExists: false, hookFired: true, hostResult: { status: null, signal: 'SIGTERM' } } },
    { name: 'spawn error', input: { markerExists: false, hookFired: false, hostResult: { error: new Error('spawn failed') } } },
    { name: 'hook never fired', input: { markerExists: false, hookFired: false, hostResult: { status: 0 } } },
  ];
  for (const { name, input } of cases) {
    const verdict = judgeProbe(input);
    assert.equal(verdict.result, null, name);
    assert.equal(typeof verdict.reason, 'string', name);
    assert.ok(!verdict.reason.includes('\n'), name);
  }
});

async function runProbeScenario(name, runHost) {
  const root = makeTempTree(`codex-bridge-probe-${name}-`);
  const host = { brandRoot: path.join(root, 'brand') };
  const rigRoot = path.join(root, 'rig-root');
  let rigDir;
  try {
    const result = await probeContract({
      host,
      version: '2.1.240',
      rigRoot,
      now: new Date('2026-08-24T12:00:00.000Z'),
      runHost(command, args, options) {
        rigDir = options.cwd;
        return runHost({ command, args, options });
      },
    });
    return { result, host, rigDir, cleanup: () => removeTempTree(root) };
  } catch (error) {
    removeTempTree(root);
    throw error;
  }
}

test('probeContract records ignored when the refused marker command ran', async () => {
  const scenario = await runProbeScenario('ignored', ({ command, args, options }) => {
    assert.equal(command, 'claude');
    assert.deepEqual(args.slice(0, 4), ['--setting-sources', 'project', '--allowedTools', 'Bash,Agent']);
    assert.equal(args.at(-2), '-p');
    assert.match(args.at(-1), new RegExp(PROBE_MARKER));
    assert.equal(options.timeout, 120000);
    const token = args.at(-1).match(/probe ([^:]+):/)[1];
    fs.writeFileSync(path.join(options.cwd, `${PROBE_MARKER}-${token}.marker`), 'ran', 'utf8');
    return { status: 0 };
  });
  try {
    assert.equal(scenario.result.state, 'probed');
    assert.equal(scenario.result.result, 'ignored');
    assert.equal(scenario.result.recorded, true);
    assert.equal((await readHostContract(scenario.host)).result, 'ignored');
    assert.equal(fs.existsSync(scenario.rigDir), false);
  } finally {
    scenario.cleanup();
  }
});

test('probeContract records honored when the hook fired and no marker appeared', async () => {
  const scenario = await runProbeScenario('honored', ({ options, args }) => {
    fs.appendFileSync(path.join(options.cwd, '.claude', 'probe-journal.log'), 'fired\n', 'utf8');
    const token = args.at(-1).match(/probe ([^:]+):/)[1];
    const okCommand = `node -e "console.log('cb-probe-ok-${token}')"`;
    const failCommand = `node -e "console.log('cb-probe-fail-${token}'); console.error('cb-probe-err-${token}'); process.exit(2)"`;
    const transcriptPath = path.join(options.cwd, 'transcript.jsonl');
    const transcript = { type: 'user', message: { content: args.at(-1) } };
    fs.mkdirSync(path.join(options.cwd, 'session', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(options.cwd, 'session', 'subagents', 'agent-a1.jsonl'), `${JSON.stringify(transcript)}\n`, 'utf8');
    const payload = (command, extra = {}) => ({ tool_input: { command }, ...extra });
    const entries = [
      { event: 'PreToolUse', payload: payload(okCommand, { agent_id: 'a1', agent_type: 'probe-agent', session_id: 'session', transcript_path: transcriptPath }), transcript: { path: path.join(options.cwd, 'session', 'subagents', 'agent-a1.jsonl'), firstLine: JSON.stringify(transcript) } },
      { event: 'PostToolUse', payload: payload(okCommand, { tool_response: { stdout: `cb-probe-ok-${token}\n` } }) },
      { event: 'PreToolUse', payload: payload(failCommand, { agent_id: 'a1', agent_type: 'probe-agent' }) },
      { event: 'PostToolUseFailure', payload: { tool_input: { command: failCommand }, error: `Exit code 2 cb-probe-fail-${token}`, agent_type: 'probe-agent' } },
    ];
    fs.writeFileSync(path.join(options.cwd, '.claude', 'dispatcher-journal.jsonl'), `${entries.map(JSON.stringify).join('\n')}\n`, 'utf8');
    return { status: 0 };
  });
  try {
    assert.equal(scenario.result.state, 'probed');
    assert.equal(scenario.result.result, 'honored');
    assert.equal((await readHostContract(scenario.host)).result, 'honored');
    const record = readDispatcherContract({ stateDir: path.join(scenario.host.brandRoot, 'state') });
    assert.deepEqual(Object.values(record.contracts).map((entry) => entry.result), ['honored', 'honored', 'honored', 'honored']);
    assert.deepEqual(Object.values(scenario.result.dispatcher).map((entry) => entry.result), ['honored', 'honored', 'honored', 'honored']);
    assert.equal(fs.existsSync(scenario.rigDir), false);
  } finally {
    scenario.cleanup();
  }
});

test('probeContract writes no record after an inconclusive host exit', async () => {
  const scenario = await runProbeScenario('inconclusive', () => ({ status: 1 }));
  try {
    assert.equal(scenario.result.state, 'inconclusive');
    assert.equal(scenario.result.result, null);
    assert.equal(scenario.result.message, 'The host exited with status 1.');
    assert.equal(scenario.result.recorded, false);
    assert.equal(fs.existsSync(hostContractPath(scenario.host)), false);
    assert.ok(Object.values(scenario.result.dispatcher).every((entry) => entry.result === 'inconclusive'));
    assert.equal(fs.existsSync(path.join(scenario.host.brandRoot, 'state', 'dispatcher-contract.json')), false);
    assert.equal(fs.existsSync(scenario.rigDir), false);
  } finally {
    scenario.cleanup();
  }
});

test('probeContract includes the final non-empty stderr line for an inconclusive host exit', async () => {
  const scenario = await runProbeScenario('inconclusive-output', () => ({
    status: 1,
    stderr: 'first host message\n  actionable host failure  \n',
    stdout: 'stdout fallback\n',
  }));
  try {
    assert.equal(scenario.result.message, 'The host exited with status 1: actionable host failure.');
  } finally {
    scenario.cleanup();
  }
});

test('probeContract skips execution when the host version is unavailable', async () => {
  let ran = false;
  const result = await probeContract({
    host: { brandRoot: 'unused' },
    version: null,
    runHost: () => { ran = true; },
  });
  assert.equal(result.state, 'inconclusive');
  assert.equal(result.recorded, false);
  assert.equal(ran, false);
});
