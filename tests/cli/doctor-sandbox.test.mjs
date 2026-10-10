/** Guards the Plan_78 B2b doctor preflight after three dead sandboxes were discovered only on orders. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { sandboxChecks } from '../../cli/doctor-sandbox.mjs';
import { check } from '../../cli/doctor-format.mjs';
import { diagnose, probeCodex } from '../../cli/doctor.mjs';
import { repositoryRoot } from '../../cli/hosts.mjs';
import { sandboxModeFor } from '../../src/home/lib/runner/codex-args.mjs';
import { formatSandboxDiagnosis } from '../../src/home/lib/runner/sandbox-diagnosis.mjs';
import { installedFixture, codexProbe, ownPackage } from './doctor-fixtures.mjs';
import { withTempTree } from '../temp-tree.mjs';

const diagnosis = {
  sources: ['sandbox.log', 'setup_error.json'],
  attributed: true,
  lines: ['runtime read/execute validation failed'],
  setupError: { text: '{"error":"locked file"}', changed: true },
  signature: { summary: 'Runtime file is locked.', repair: 'Close the file holder and retry.' },
};

test('a full-sentence probe reason joins the folder clause without a stray period', async () => {
  await withTempTree('doctor-sandbox-period-', async (cwd) => {
    const rows = await sandboxChecks({
      codexAvailable: true, cwd, platform: 'win32',
      probe: async () => ({ outcome: 'alive', reason: 'The Codex sandbox started a process.' }),
    });
    for (const row of rows) assert.ok(row.value.startsWith('The Codex sandbox started a process; probed folder:'), row.value);
  });
});

for (const [outcome, status, expected] of [
  ['alive', 'ok', 'probe reason; probed folder:'],
  ['dead', 'fail', 'probe reason\n'],
  ['skipped', 'warn', "not probed on darwin: the package has never observed this platform's sandbox"],
]) {
  test(`${outcome} maps to ${status} and names the folder`, async () => {
    await withTempTree('doctor-sandbox-outcome-', async (cwd) => {
      const calls = [];
      const rows = await sandboxChecks({
        codexAvailable: true, cwd, platform: 'darwin',
        probe: async ({ agent }) => {
          calls.push(agent);
          return { outcome, reason: 'probe reason', diagnosis };
        },
      });
      assert.deepEqual(calls, ['codex-scout', 'codex-build']);
      assert.deepEqual(rows.map(({ key }) => key), ['sandbox:read-only', 'sandbox:workspace-write']);
      for (const row of rows) {
        assert.equal(row.status, status);
        assert.ok(row.value.startsWith(expected), row.value);
        assert.ok(row.value.includes(`${cwd} (current folder)`));
      }
    });
  });
}

test('an inconclusive read-only probe warns without starting workspace-write', async () => {
  await withTempTree('doctor-sandbox-inconclusive-', async (cwd) => {
    const calls = [];
    const rows = await sandboxChecks({ cwd, probe: async ({ agent }) => {
      calls.push(agent);
      return { outcome: 'inconclusive', reason: 'timed out.' };
    } });
    assert.deepEqual(calls, ['codex-scout']);
    assert.deepEqual(rows.map(({ key, status }) => ({ key, status })), [
      { key: 'sandbox:read-only', status: 'warn' },
      { key: 'sandbox:workspace-write', status: 'warn' },
    ]);
    assert.equal(rows[0].value, `readiness not established: timed out; probed folder: ${cwd} (current folder)`);
    assert.equal(rows[1].value, `not probed: the read-only probe was inconclusive; rerun codex-bridge doctor; probed folder: ${cwd} (current folder)`);
  });
});

test('dead prints each shared diagnosis row indented and tells the operator to rerun doctor', async () => {
  await withTempTree('doctor-sandbox-diagnosis-', async (cwd) => {
    const rows = await sandboxChecks({
      cwd, probe: async () => ({ outcome: 'dead', reason: 'cannot start', diagnosis }),
    });
    const expected = [
      'cannot start',
      ...formatSandboxDiagnosis(diagnosis).map((line) => `    ${line}`),
      '    Repair the host sandbox and rerun codex-bridge doctor.',
      `    Probed folder: ${cwd} (current folder)`,
    ].join('\n');
    assert.deepEqual(rows.map(({ value }) => value), [expected, expected]);
  });
});

for (const result of [
  { outcome: 'dead', reason: 'cannot start', diagnosis: null },
  { outcome: 'dead', reason: 'cannot start' },
]) {
  test(`dead with ${'diagnosis' in result ? 'null' : 'absent'} diagnosis prints the fallback`, async () => {
    await withTempTree('doctor-sandbox-fallback-', async (cwd) => {
      const rows = await sandboxChecks({ cwd, probe: async () => result });
      for (const row of rows) {
        assert.equal(row.status, 'fail');
        assert.ok(row.value.includes('\n    No sandbox log diagnosis is available.\n'));
        assert.ok(row.value.includes('\n    Repair the host sandbox and rerun codex-bridge doctor.'));
      }
    });
  });
}

test('scout resolves before build starts and both receive the shared mapping and 15000 ms budget', async () => {
  await withTempTree('doctor-sandbox-sequential-', async (cwd) => {
    const events = [];
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const pending = sandboxChecks({
      cwd, platform: 'win32',
      probe: async (options) => {
        events.push(`start:${options.agent}`);
        assert.deepEqual(options, {
          agent: events.length === 1 ? 'codex-scout' : 'codex-build',
          repo: cwd, platform: 'win32', timeoutMs: 15000,
        });
        if (options.agent === 'codex-scout') await first;
        events.push(`resolved:${options.agent}`);
        return { outcome: 'alive', reason: 'started' };
      },
    });
    try {
      await Promise.resolve();
      assert.deepEqual(events, ['start:codex-scout']);
    } finally {
      releaseFirst();
    }
    const rows = await pending;
    assert.deepEqual(events, [
      'start:codex-scout', 'resolved:codex-scout', 'start:codex-build', 'resolved:codex-build',
    ]);
    assert.deepEqual(rows.map(({ key }) => key),
      ['codex-scout', 'codex-build'].map((agent) => `sandbox:${sandboxModeFor(agent)}`));
  });
});

test('custom timeout reaches both probes', async () => {
  await withTempTree('doctor-sandbox-timeout-', async (cwd) => {
    const timeouts = [];
    await sandboxChecks({ cwd, timeoutMs: 1234, probe: async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      return { outcome: 'alive', reason: 'started' };
    } });
    assert.deepEqual(timeouts, [1234, 1234]);
  });
});

test('unavailable Codex never invokes the probe and warns for both forms', async () => {
  await withTempTree('doctor-sandbox-unavailable-', async (cwd) => {
    const rows = await sandboxChecks({
      cwd, codexAvailable: false, probe: () => assert.fail('must not probe unavailable CLI'),
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'warn');
      assert.ok(row.value.startsWith('not probed: Codex CLI is unavailable'));
      assert.ok(row.value.includes(`${cwd} (current folder)`));
    }
  });
});

test('a subfolder probes its git repository root and names it as a git repository', async () => {
  await withTempTree('doctor-sandbox-git-', async (root) => {
    await fs.mkdir(path.join(root, '.git'));
    const cwd = path.join(root, 'sub', 'folder');
    await fs.mkdir(cwd, { recursive: true });
    const repos = [];
    const rows = await sandboxChecks({ cwd, probe: async ({ repo }) => {
      repos.push(repo);
      return { outcome: 'alive', reason: 'started' };
    } });
    assert.deepEqual(repos, [root, root]);
    for (const row of rows) assert.ok(row.value.includes(`${root} (git repository)`));
  });
});

test('outside git probes the current folder itself', async () => {
  await withTempTree('doctor-sandbox-folder-', async (cwd) => {
    const repos = [];
    const rows = await sandboxChecks({ cwd, probe: async ({ repo }) => {
      repos.push(repo);
      return { outcome: 'alive', reason: 'started' };
    } });
    assert.deepEqual(repos, [cwd, cwd]);
    for (const row of rows) assert.ok(row.value.includes(`${cwd} (current folder)`));
  });
});

test('cwd and platform defaults reach the probe', async () => {
  const calls = [];
  await sandboxChecks({ probe: async (options) => {
    calls.push(options);
    return { outcome: 'alive', reason: 'started' };
  } });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.repo, repositoryRoot(process.cwd()));
    assert.equal(call.platform, process.platform);
  }
});

test('diagnose injects sandbox rows immediately after Codex; fail exits 1 and warn preserves the baseline', async (t) => {
  const { host } = await installedFixture(t);
  await withTempTree('doctor-sandbox-runs-', async (runsRoot) => {
    const previous = process.env.CODEX_RUNS_ROOT;
    process.env.CODEX_RUNS_ROOT = runsRoot;
    try {
      const options = {
        host, codexProbe, currentPackage: ownPackage,
        bridgeProbe: () => ({ available: true, value: 'fixture' }),
        hostVersion: null, contractRecord: null, handbackWitnessRecord: null,
        dispatcherModelRecord: null, dispatcherContractRecord: null, observations: [],
      };
      const baseline = await diagnose(options);
      assert.equal(baseline.exitCode, 0);
      assert.ok(!baseline.checks.some(({ key }) => key.startsWith('sandbox:')));
      for (const status of ['fail', 'warn']) {
        const sandbox = async (input) => {
          assert.deepEqual(input, { codexAvailable: true });
          await Promise.resolve();
          return [check('sandbox:workspace-write', status, 'fixture sandbox')];
        };
        const result = await diagnose({ ...options, sandbox });
        assert.equal(result.exitCode, status === 'fail' ? 1 : baseline.exitCode);
        const index = result.checks.findIndex(({ key }) => key === 'codex');
        assert.equal(result.checks[index + 1].key, 'sandbox:workspace-write');
        assert.equal(result.checks[index + 2].key, 'node');
      }
      const unavailable = await diagnose({
        ...options, codexProbe: () => ({ available: false, value: 'not found' }),
        sandbox: async (input) => {
          assert.deepEqual(input, { codexAvailable: false });
          return [];
        },
      });
      assert.equal(unavailable.exitCode, baseline.exitCode);
    } finally {
      if (previous === undefined) delete process.env.CODEX_RUNS_ROOT;
      else process.env.CODEX_RUNS_ROOT = previous;
    }
  });
});

test('doctor command passes sandboxChecks to diagnose', async () => {
  const source = await fs.readFile(new URL('../../cli/command-registry.mjs', import.meta.url), 'utf8');
  assert.match(source, /import\s*\{\s*sandboxChecks\s*\}\s*from\s*['"]\.\/doctor-sandbox\.mjs['"]/);
  const doctor = source.slice(source.indexOf("name: 'doctor'"), source.indexOf("name: 'run'"));
  assert.match(doctor, /diagnose\(\{\s*host,\s*sandbox:\s*sandboxChecks\s*\}\)/);
});

test('Codex version timeout is bounded and reported even if stderr is present', (t) => {
  const spawn = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(options.timeout, 15000);
    assert.equal(options.windowsHide, true);
    assert.ok(args.includes('--version') || args.includes('codex --version'));
    return { error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }), stderr: 'partial output' };
  });
  syncBuiltinESMExports();
  try {
    const result = probeCodex();
    assert.equal(result.available, false);
    assert.match(result.value, /timed out.*15000/);
    assert.equal(spawn.mock.callCount(), 1);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});
