import assert from 'node:assert/strict';
import test from 'node:test';
import {
  probeCodexAvailability, PROBE_TIMEOUT_MS,
} from '../../src/home/lib/runner/codex-availability.mjs';

const success = { status: 0, stdout: '', stderr: '' };
const signedOut = {
  status: 1,
  stdout: '',
  stderr: 'WARNING: proceeding, even though we could not create PATH aliases: ...\nNot logged in\n',
};

function fixture(results, overrides = {}) {
  const calls = [];
  const options = {
    platform: 'linux',
    resolve: () => '/fake/codex',
    run: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions });
      assert.ok(calls.length <= results.length, 'unexpected probe call');
      return results[calls.length - 1];
    },
    ...overrides,
  };
  return { calls, probe: () => probeCodexAvailability(options) };
}

test('two PATH misses in the supplied env leave readiness inconclusive before any spawn', async () => {
  const env = { PATH: '/empty', CODEX_HOME: '/auth' };
  let resolutions = 0;
  const delays = [];
  const { probe, calls } = fixture([], {
    env,
    delay: async (ms) => { delays.push(ms); },
    resolve: (command, receivedEnv) => {
      resolutions += 1;
      assert.equal(command, 'codex');
      assert.equal(receivedEnv, env);
      return null;
    },
  });
  assert.deepEqual(await probe(), {
    state: 'inconclusive', pathMiss: true,
    detail: 'codex could not be resolved in this process PATH; readiness is unconfirmed',
  });
  assert.equal(resolutions, 2);
  assert.deepEqual(delays, [1000]);
  assert.equal(calls.length, 0);
});

test('a PATH miss then a hit retries once with the injected delay before version and login status', async () => {
  const env = { PATH: '/updating', CODEX_HOME: '/auth' };
  const events = [];
  let resolutions = 0;
  const { probe, calls } = fixture([success, success], {
    env,
    retryDelayMs: 42,
    delay: async (ms) => { events.push(['delay', ms]); },
    resolve: (command, receivedEnv) => {
      assert.equal(command, 'codex');
      assert.equal(receivedEnv, env);
      events.push(['resolve', ++resolutions]);
      return resolutions === 1 ? null : '/fake/codex';
    },
  });
  assert.deepEqual(await probe(), { state: 'available' });
  assert.deepEqual(events, [['resolve', 1], ['delay', 42], ['resolve', 2]]);
  assert.deepEqual(calls.map(({ args }) => args), [['--version'], ['login', 'status']]);
});

test('version failure stops before login and uses the last non-empty stderr line', async () => {
  const { probe, calls } = fixture([
    { status: 2, stderr: 'WARNING: unrelated\n  version failed  \n\n', error: new Error('other') },
  ]);
  assert.deepEqual(await probe(), { state: 'inconclusive', detail: 'version failed' });
  assert.deepEqual(calls.map(({ args }) => args), [['--version']]);
});

test('signed in is available only after version then login status', async () => {
  const delays = [];
  const { probe, calls } = fixture([success, success], {
    delay: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(await probe(), { state: 'available' });
  assert.deepEqual(delays, []);
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'codex', args: ['--version'] },
    { command: 'codex', args: ['login', 'status'] },
  ]);
});

test('measured signed-out stderr with unrelated warnings proves sign-out', async () => {
  const { probe } = fixture([success, signedOut]);
  assert.deepEqual(await probe(), { state: 'logged-out', detail: 'codex login status: Not logged in' });
});

test('an exact trimmed stdout line also proves sign-out', async () => {
  const { probe } = fixture([success, { status: 1, stdout: '  Not logged in  \r\n', stderr: '' }]);
  assert.deepEqual(await probe(), { state: 'logged-out', detail: 'codex login status: Not logged in' });
});

for (const stderr of ['other text', 'WARNING: Not logged in', 'Not logged in: expired', 'not logged in']) {
  test(`status 1 with ${JSON.stringify(stderr)} is inconclusive`, async () => {
    const { probe } = fixture([success, { status: 1, stderr }]);
    assert.deepEqual(await probe(), { state: 'inconclusive', detail: stderr });
  });
}

for (const status of [2, null]) {
  test(`login status ${status} cannot prove sign-out even with the exact line`, async () => {
    const { probe } = fixture([success, { ...signedOut, status }]);
    assert.deepEqual(await probe(), { state: 'inconclusive', detail: 'Not logged in' });
  });
}

for (const stage of ['version', 'login']) {
  test(`${stage} timeout is inconclusive`, async () => {
    const timeout = { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    const { probe, calls } = fixture(stage === 'version' ? [timeout] : [success, timeout]);
    assert.deepEqual(await probe(), { state: 'inconclusive', detail: 'timed out' });
    assert.equal(calls.length, stage === 'version' ? 1 : 2);
  });
}

for (const status of [0, 1]) {
  test(`capture error overrides login status ${status} and sign-out text`, async () => {
    const { probe } = fixture([success, { ...signedOut, status, error: new Error('capture failed') }]);
    assert.deepEqual(await probe(), { state: 'inconclusive', detail: 'Not logged in' });
  });
}

for (const stage of ['version', 'login']) {
  test(`${stage} without stderr or error reports the exit status`, async () => {
    const result = { status: 3, stdout: '' };
    const { probe } = fixture(stage === 'version' ? [result] : [success, result]);
    const command = stage === 'version' ? 'codex --version' : 'codex login status';
    assert.deepEqual(await probe(), { state: 'inconclusive', detail: `${command} exited 3` });
  });
}

test('localized command-not-found stderr cannot prove missing after successful resolution', async () => {
  const stderr = '"codex" is not recognized as an internal or external command';
  const { probe } = fixture([{ status: 1, stderr }]);
  assert.deepEqual(await probe(), { state: 'inconclusive', detail: stderr });
});

for (const timeoutMs of [undefined, 321]) {
  test(`the original env and ${timeoutMs ?? 'default'} timeout reach every spawn`, async () => {
    const env = { PATH: '/fake', CODEX_HOME: '/same-authorization-context' };
    const overrides = timeoutMs === undefined ? { env } : { env, timeoutMs };
    const { probe, calls } = fixture([success, success], overrides);
    assert.deepEqual(await probe(), { state: 'available' });
    assert.equal(PROBE_TIMEOUT_MS, 10_000);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.options.env, env);
      assert.equal(call.options.timeout, timeoutMs ?? PROBE_TIMEOUT_MS);
      assert.equal(call.options.encoding, 'utf8');
    }
  });
}

test('Windows probes use ComSpec and the shared spawn specification', async () => {
  const { probe, calls } = fixture([success, success], { platform: 'win32' });
  assert.deepEqual(await probe(), { state: 'available' });
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.command, process.env.ComSpec || 'cmd.exe');
    const command = index === 0 ? 'codex --version' : 'codex login status';
    assert.deepEqual(call.args, ['/d', '/s', '/c', `"${command}"`]);
    assert.equal(call.options.windowsVerbatimArguments, true);
    assert.equal(call.options.windowsHide, true);
  }
});

test('resolver exceptions cannot become absence', async () => {
  const { probe, calls } = fixture([], { resolve: () => { throw new Error('cannot inspect PATH'); } });
  assert.deepEqual(await probe(), { state: 'inconclusive', detail: 'cannot inspect PATH' });
  assert.equal(calls.length, 0);
});

test('a resolver exception on retry stays inconclusive without claiming a PATH miss', async () => {
  let resolutions = 0;
  const delays = [];
  const { probe, calls } = fixture([], {
    delay: async (ms) => { delays.push(ms); },
    resolve: () => {
      if (++resolutions === 1) return null;
      throw new Error('cannot inspect PATH');
    },
  });
  assert.deepEqual(await probe(), { state: 'inconclusive', detail: 'cannot inspect PATH' });
  assert.equal(resolutions, 2);
  assert.deepEqual(delays, [1000]);
  assert.equal(calls.length, 0);
});

test('runner rejections remain inconclusive with a one-line detail', async () => {
  const { probe } = fixture([], { run: async () => { throw new Error('warning\nprobe failed\n'); } });
  assert.deepEqual(await probe(), { state: 'inconclusive', detail: 'probe failed' });
});
