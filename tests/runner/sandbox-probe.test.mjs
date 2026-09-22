/** Guards Plan_57's host verdict without starting Codex or spending quota. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxModeFor } from '../../src/home/lib/runner/codex-args.mjs';
import { codexSpawnSpec } from '../../src/home/lib/runner/codex-cmd.mjs';
import {
  SANDBOX_PROBE_MARKER as MARKER, PROBED_PLATFORMS, probeSandbox, sandboxRefusal,
} from '../../src/home/lib/runner/sandbox-probe.mjs';

const repo = 'C:\\repository with spaces & punctuation';
const success = { status: 0, stdout: `${MARKER}\r\n` };
const failure = { status: 1 };
const version = { status: 0, stdout: 'codex-cli fixture' };

function fixture(replies) {
  const calls = [];
  const run = (command, args, options) => {
    const text = args.join(' ');
    const form = text.includes('--version') ? 'version'
      : text.includes('sandbox_mode=') ? 'flagged' : 'control';
    calls.push({ form, command, args, options });
    assert.ok(Object.hasOwn(replies, form), `unexpected ${form} attempt`);
    return { stdout: '', stderr: '', signal: null, ...replies[form] };
  };
  return { run, calls };
}

async function probe(replies, options = {}) {
  const { run, calls } = fixture(replies);
  const result = await probeSandbox({ agent: 'codex-scout', repo, platform: 'win32', ...options, run });
  return { result, calls };
}

function assertAttempts(result, calls, forms) {
  assert.deepEqual(result.attempts.map(({ form }) => form), forms);
  assert.deepEqual(calls.map(({ form }) => form), forms);
  for (const attempt of result.attempts) {
    assert.deepEqual(Object.keys(attempt).sort(), ['form', 'marker', 'ms', 'status', 'stderrTail']);
    assert.equal(typeof attempt.marker, 'boolean');
    assert.ok(Number.isFinite(attempt.ms) && attempt.ms >= 0);
    assert.equal(typeof attempt.stderrTail, 'string');
    assert.ok(attempt.stderrTail.length <= 300);
  }
}

test('the marker and platform gate are the agreed constants', () => {
  assert.equal(MARKER, 'codex-bridge-sandbox-ok');
  assert.deepEqual(PROBED_PLATFORMS, new Set(['win32', 'linux']));
});

for (const [agent, mode] of [
  ['codex-build', 'workspace-write'], ['codex-scout', 'read-only'], ['codex-review', 'read-only'],
  ['codex-advisor', 'read-only'],
]) {
  test(`${agent} is alive after one flagged Windows attempt using its role sandbox`, async () => {
    assert.equal(sandboxModeFor(agent), mode);
    const { result, calls } = await probe({ flagged: success }, { agent });
    assert.equal(result.outcome, 'alive');
    assertAttempts(result, calls, ['flagged']);
    assert.equal(result.attempts[0].status, 0);
    assert.equal(result.attempts[0].marker, true);
    assert.equal(calls[0].command, process.env.ComSpec || 'cmd.exe');
    assert.deepEqual(calls[0].args, ['/d', '/s', '/c',
      `"codex sandbox -c windows.sandbox=elevated -c sandbox_mode=${mode} -- cmd /d /c echo ${MARKER}"`]);
    assert.deepEqual(calls[0].options, {
      windowsVerbatimArguments: true, windowsHide: true,
      cwd: repo, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(calls[0].args.join(' ').includes('-C'), false);
    assert.equal(Object.hasOwn(calls[0].options, 'shell'), false);
  });
}

test('unknown and missing roles fail before any process is started', async () => {
  for (const agent of ['codex-unknown', undefined]) {
    assert.throws(() => sandboxModeFor(agent), /unknown agent/);
    const { run, calls } = fixture({});
    await assert.rejects(() => probeSandbox({ agent, repo, platform: 'win32', run }), /unknown agent/);
    assert.equal(calls.length, 0);
  }
});

test('a required repository is never silently replaced with the caller directory', async () => {
  for (const missingRepo of [undefined, '']) {
    await assert.rejects(() => probe({}, { repo: missingRepo }), /requires a repository path/);
  }
});

test('two failed sandbox forms and a live CLI prove dead, with the supplied timeout on all calls', async () => {
  const { result, calls } = await probe({ flagged: failure, control: failure, version }, { timeoutMs: 1234 });
  assert.equal(result.outcome, 'dead');
  assert.match(result.reason, /cannot start a process/);
  assertAttempts(result, calls, ['flagged', 'control', 'version']);
  assert.deepEqual(result.attempts.map(({ status, marker }) => [status, marker]),
    [[1, false], [1, false], [0, false]]);
  assert.deepEqual(calls[1].args, ['/d', '/s', '/c', `"codex sandbox -- cmd /d /c echo ${MARKER}"`]);
  assert.deepEqual(calls[2].args, ['/d', '/s', '/c', '"codex --version"']);
  for (const call of calls) {
    assert.equal(call.command, process.env.ComSpec || 'cmd.exe');
    assert.equal(call.options.cwd, repo);
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.timeout, 1234);
    assert.equal(Object.hasOwn(call.options, 'shell'), false);
  }
});

// D16: the -C/--permission-profile incident showed that a failure code alone is not a diagnosis.
for (const [name, response, reason] of [
  ['argument rejection', { status: 2 }, /rejected.*arguments/],
  ['spawn error', { status: null, error: { code: 'ENOENT' } }, /could not start or complete/],
  ['signal', { status: null, signal: 'SIGTERM' }, /terminated by SIGTERM/],
  ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }, /timed out/],
  ['missing exit status', { status: null }, /no exit status/],
]) {
  for (const form of ['flagged', 'control']) {
    test(`${form} ${name} is inconclusive and stops before the next attempt`, async () => {
      const replies = form === 'flagged' ? { flagged: response } : { flagged: failure, control: response };
      const { result, calls } = await probe(replies);
      assert.equal(result.outcome, 'inconclusive');
      assert.match(result.reason, reason);
      assertAttempts(result, calls, form === 'flagged' ? ['flagged'] : ['flagged', 'control']);
    });
  }
}

test('a control marker reports incompatible package flags and never starts version', async () => {
  const { result, calls } = await probe({ flagged: failure, control: success });
  assert.equal(result.outcome, 'inconclusive');
  assert.match(result.reason, /no longer accepts the package sandbox flags/);
  assertAttempts(result, calls, ['flagged', 'control']);
  assert.equal(result.attempts[1].marker, true);
});

test('a control marker remains inconclusive even with a nonzero exit', async () => {
  const { result, calls } = await probe({ flagged: failure, control: { ...success, status: 1 } });
  assert.equal(result.outcome, 'inconclusive');
  assertAttempts(result, calls, ['flagged', 'control']);
});

for (const [name, response] of [
  ['nonzero exit', { status: 1 }],
  ['argument exit', { status: 2 }],
  ['spawn error', { status: null, error: { code: 'ENOENT' } }],
  ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }],
  ['signal', { status: null, signal: 'SIGTERM' }],
]) {
  test(`version ${name} leaves CLI availability to codexUnavailableReason`, async () => {
    const { result, calls } = await probe({ flagged: failure, control: failure, version: response });
    assert.equal(result.outcome, 'inconclusive');
    assert.equal(result.reason, 'Codex CLI is unavailable.');
    assertAttempts(result, calls, ['flagged', 'control', 'version']);
  });
}

test('dead is not pinned to exit 1, and a zero exit without stdout marker is insufficient', async () => {
  for (const status of [0, 3, 127]) {
    const { result, calls } = await probe({ flagged: { status }, control: { status }, version });
    assert.equal(result.outcome, 'dead');
    assertAttempts(result, calls, ['flagged', 'control', 'version']);
  }
});

test('a flagged marker needs exit zero and cannot override an interrupted attempt', async () => {
  const { result, calls } = await probe({ flagged: { ...success, status: 1 } });
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.reason, 'The flagged sandbox probe printed the marker but exited 1.');
  assertAttempts(result, calls, ['flagged']);
  for (const interruption of [{ error: { code: 'ETIMEDOUT' } }, { signal: 'SIGTERM' }]) {
    const { result: interrupted, calls } = await probe({ flagged: { ...success, ...interruption } });
    assert.equal(interrupted.outcome, 'inconclusive');
    assertAttempts(interrupted, calls, ['flagged']);
  }
});

test('darwin is skipped immediately without running or validating an unused role', async () => {
  const { result, calls } = await probe({}, { platform: 'darwin', agent: 'codex-unknown', repo: undefined });
  assert.deepEqual(result, { outcome: 'skipped' });
  assert.equal(calls.length, 0);
});

// The two outcomes seen live on an Ubuntu 24.04 VPS on 2026-09-17, before and after the AppArmor repair.
test('Linux is judged with direct POSIX commands for every form', async () => {
  const { result, calls } = await probe({ flagged: failure, control: failure, version },
    { platform: 'linux', repo: '/repository with spaces' });
  assert.equal(result.outcome, 'dead');
  assertAttempts(result, calls, ['flagged', 'control', 'version']);
  assert.deepEqual(calls.map(({ args }) => args), [
    ['sandbox', '-c', 'sandbox_mode=read-only', '--', 'echo', MARKER],
    ['sandbox', '--', 'echo', MARKER], ['--version'],
  ]);
  for (const call of calls) {
    assert.equal(call.command, 'codex');
    assert.deepEqual(call.options, { cwd: '/repository with spaces', encoding: 'utf8', timeout: 30_000 });
  }
  const alive = await probe({ flagged: success }, { platform: 'linux', agent: 'codex-build', repo: '/repo' });
  assert.equal(alive.result.outcome, 'alive');
  assert.deepEqual(alive.calls.map(({ args }) => args), [
    ['sandbox', '-c', 'sandbox_mode=workspace-write', '--', 'echo', MARKER],
  ]);
});

test('policy-looking stderr and a stderr-only marker never decide the outcome', async () => {
  const { result } = await probe({
    flagged: { status: 1, stderr: `blocked by policy\n${MARKER}` },
    control: { status: 1, stderr: 'is not recognized' }, version,
  });
  assert.equal(result.outcome, 'dead');
  assert.equal(result.attempts[0].marker, false);
  assert.equal(result.attempts[0].stderrTail, `blocked by policy\n${MARKER}`);
  assert.equal((await probe({ flagged: { ...success, stderr: 'blocked by policy; error; timeout' } })).result.outcome,
    'alive');
});

test('stderr tails keep only the last 300 characters and absent streams are accepted', async () => {
  const stderr = 'discarded prefix\n' + 'x'.repeat(299) + '!';
  const { result } = await probe({
    flagged: { status: 1, stdout: null, stderr }, control: { status: 1, stderr: null }, version,
  });
  assert.equal(result.outcome, 'dead');
  assert.equal(result.attempts[0].stderrTail, stderr.slice(-300));
  assert.equal(result.attempts[1].stderrTail, '');
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} refusal supplies the manual control, both quoted tails, and quota assurance`, async () => {
    const { result } = await probe({
      flagged: { status: 1, stderr: 'flagged problem\r\nsecond line' },
      control: { status: 1, stderr: 'control problem' },
      version: { status: 0, stderr: 'version text is not a sandbox diagnosis' },
    });
    const refusal = sandboxRefusal(result, platform);
    assert.ok(refusal.includes(result.reason));
    assert.match(refusal, /Repair the host sandbox; do not rewrite or retry the order/);
    assert.match(refusal, /run from the repository directory/);
    const control = platform === 'win32' ? `codex sandbox -- cmd /d /c echo ${MARKER}`
      : `codex sandbox -- echo ${MARKER}`;
    assert.ok(refusal.includes(control));
    assert.ok(refusal.includes('flagged stderr:\n> flagged problem\n> second line'));
    assert.ok(refusal.includes('control stderr:\n> control problem'));
    // Only Linux gets the AppArmor repair: on Windows the known cause is a corrupted state file.
    assert.equal(refusal.includes('https://learn.chatgpt.com/docs/sandboxing'), platform === 'linux');
    assert.equal(refusal.includes('apparmor_restrict_unprivileged_userns=0'), platform === 'linux');
    assert.equal(refusal.includes('version text'), false);
    assert.ok(refusal.endsWith('The run folder was not created; quota was not spent.'));
  });
}

test('codexSpawnSpec preserves Windows argument quoting and direct POSIX argument identity', () => {
  const args = ['exec', '-C', 'C:\\work tree', 'a&b', 'a|b', '<value>', 'caret^arg', 'plain'];
  assert.deepEqual(codexSpawnSpec(args, 'win32'), {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', '"codex exec -C "C:\\work tree" "a&b" "a|b" "<value>" "caret^arg" plain"'],
    options: { windowsVerbatimArguments: true, windowsHide: true },
  });
  for (const platform of ['linux', 'darwin']) {
    const spec = codexSpawnSpec(args, platform);
    assert.deepEqual(spec, { command: 'codex', args, options: {} });
    assert.equal(spec.args, args);
  }
  assert.deepEqual(codexSpawnSpec(args), codexSpawnSpec(args, process.platform));
});

test('codexSpawnSpec uses ComSpec when set and cmd.exe when absent', () => {
  const original = process.env.ComSpec;
  try {
    process.env.ComSpec = 'C:\\Windows\\System32\\custom-cmd.exe';
    assert.equal(codexSpawnSpec(['--version'], 'win32').command, process.env.ComSpec);
    delete process.env.ComSpec;
    assert.equal(codexSpawnSpec(['--version'], 'win32').command, 'cmd.exe');
  } finally {
    if (original === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = original;
  }
});

test('a promise-returning injected run still proves the sandbox alive', async () => {
  const { run, calls } = fixture({ flagged: success });
  const result = await probeSandbox({
    agent: 'codex-scout', repo, platform: 'win32',
    run: (...args) => Promise.resolve(run(...args)),
  });
  assert.equal(result.outcome, 'alive');
  assertAttempts(result, calls, ['flagged']);
});
