/** Verifies the real-host refusal probe without ever spawning Claude Code. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hostContractPath, readHostContract } from '../../cli/host-contract.mjs';
import {
  PROBE_MARKER,
  buildRig,
  judgeProbe,
  probeContract,
} from '../../cli/probe-contract.mjs';
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

test('buildRig registers exactly one Bash PreToolUse hook and a simple marker command', async () => {
  const root = makeTempTree('codex-bridge-probe-rig-');
  try {
    const rig = await buildRig(root);
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse']);
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
    assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /probe-hook\.mjs/);
    assert.ok(rig.command.includes(PROBE_MARKER));
    for (const forbidden of ['`', '$(', '${', '&&', '||', '|', ';']) {
      assert.ok(!rig.command.includes(forbidden), forbidden);
    }
  } finally {
    removeTempTree(root);
  }
});

test('the generated hook refuses the marker command and journals exactly once', async () => {
  const root = makeTempTree('codex-bridge-probe-hook-refuse-');
  try {
    const rig = await buildRig(root);
    const hookPath = path.join(root, '.claude', 'hooks', 'probe-hook.mjs');
    const child = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_input: { command: rig.command } }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Contract probe refused its marker command.',
      },
    });
    assert.deepEqual(fs.readFileSync(rig.journalPath, 'utf8').split('\n'), [PROBE_MARKER, '']);
  } finally {
    removeTempTree(root);
  }
});

test('the generated hook stays silent for an unrelated command', async () => {
  const root = makeTempTree('codex-bridge-probe-hook-pass-');
  try {
    const rig = await buildRig(root);
    const hookPath = path.join(root, '.claude', 'hooks', 'probe-hook.mjs');
    const child = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_input: { command: 'pwd' } }),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(fs.existsSync(rig.journalPath), false);
  } finally {
    removeTempTree(root);
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
    assert.deepEqual(args.slice(0, 4), ['--setting-sources', 'project', '--allowedTools', 'Bash']);
    assert.equal(args.at(-2), '-p');
    assert.match(args.at(-1), new RegExp(PROBE_MARKER));
    assert.equal(options.timeout, 120000);
    fs.writeFileSync(path.join(options.cwd, `${PROBE_MARKER}.marker`), 'ran', 'utf8');
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
  const scenario = await runProbeScenario('honored', ({ options }) => {
    fs.appendFileSync(path.join(options.cwd, '.claude', 'probe-journal.log'), 'fired\n', 'utf8');
    return { status: 0 };
  });
  try {
    assert.equal(scenario.result.state, 'probed');
    assert.equal(scenario.result.result, 'honored');
    assert.equal((await readHostContract(scenario.host)).result, 'honored');
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
