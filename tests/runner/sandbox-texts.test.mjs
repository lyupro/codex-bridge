/** Plan_79 B4h D7: literal outputs lock the shared order/doctor text before registry migration. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { ADMISSION_FILES } from '../order-guard/admission-files.mjs';
import { checkRefusalSites } from '../order-guard/refusal-checker.mjs';
import { withTempTree } from '../temp-tree.mjs';
import { probeSandbox, sandboxRefusal } from '../../src/home/lib/runner/sandbox-probe.mjs';
import { snapshotSandboxLogs, diagnoseSandbox, formatSandboxDiagnosis }
  from '../../src/home/lib/runner/sandbox-diagnosis.mjs';

const now = new Date(2026, 9, 10, 12);
const dead = 'The Codex sandbox on this host cannot start a process.';
const noRepair = 'No verified repair signature; inspect this log.';
const failures = [
  {
    id: 'runtime-file-locked',
    line: 'setup error: runtime read/execute validation failed: file.dll: open ACL target for root-only update (os error 32)',
    summary: 'A file under the Codex runtimes folder is held open by another process, so sandbox setup cannot update its access rights (openai/codex #51634).',
    repair: () => 'Find and close the process holding the file named in the line (on 2026-10-10, the Codex desktop app\'s computer-use helper), then rerun codex-bridge doctor; on Codex CLI 0.162.x the proven workaround is npm install -g @openai/codex@0.160.1.',
  },
  {
    id: 'deny-read-state-corrupt',
    line: 'setup error: deny_read_acl_state.json: expected value at line 1 column 1',
    summary: 'The sandbox state file is empty or corrupt.',
    repair: (home) => `Back up and rename ${path.join(home, '.sandbox', 'deny_read_acl_state.json')}, then rerun codex-bridge doctor; the helper recreates it.`,
  },
];

function fixture(home) {
  const folder = path.join(home, '.sandbox');
  fs.mkdirSync(folder);
  return { log: path.join(folder, 'sandbox.2026-10-10.log'), setup: path.join(folder, 'setup_error.json') };
}

function expectedRefusal(reason, platform, rows = []) {
  return [
    reason,
    'Repair the host sandbox; do not rewrite or retry the order.',
    ...(platform === 'linux' ? [
      'On Ubuntu 23.10 and later this usually means AppArmor does not let bubblewrap create a user namespace. ' +
      'Official repair: https://learn.chatgpt.com/docs/sandboxing — the bwrap-userns-restrict AppArmor profile ' +
      '(Ubuntu 24.04) or the bubblewrap package (25.04 and later). Do not set ' +
      'kernel.apparmor_restrict_unprivileged_userns=0: it lifts the restriction for every program on the host.',
    ] : []),
    platform === 'linux'
      ? 'Operator check (run from the repository directory): codex sandbox -- echo codex-bridge-sandbox-ok'
      : 'Operator check (run from the repository directory): codex sandbox -- cmd /d /c echo codex-bridge-sandbox-ok',
    'flagged stderr:\n> first error\n> second error\n> third error',
    'control stderr:\n> (empty)',
    ...(rows.length ? [rows.join('\n')] : []),
    'The run folder was not created; quota was not spent.',
  ].join('\n\n');
}

function refusalResult(reason, diagnosis) {
  return { reason, diagnosis, attempts: [
    { form: 'flagged', stderrTail: 'first error\r\nsecond error\rthird error' },
    { form: 'control', stderrTail: '' },
    { form: 'version', stderrTail: 'not sandbox evidence' },
  ] };
}

const diagnoses = [
  ['attributed without signature', {
    sources: ['sandbox.log'], attributed: true, lines: ['setup error: other failure'],
    setupError: { text: null, changed: false }, signature: null,
  }, ['Sandbox diagnosis source: sandbox.log', 'Sandbox log lines attributed to this probe:',
    '> setup error: other failure', noRepair]],
  ['unattributed without signature', {
    sources: ['sandbox.log'], attributed: false, lines: ['setup error: old failure'],
    setupError: { text: null, changed: false }, signature: null,
  }, ['Sandbox diagnosis source: sandbox.log', 'Recent sandbox log lines only; not attributed to this probe:',
    '> setup error: old failure', noRepair]],
  ['no evidence', {
    sources: [], attributed: false, lines: [], setupError: { text: null, changed: false }, signature: null,
  }, ['Recent sandbox log lines only; not attributed to this probe:', noRepair]],
];
for (const [changed, label] of [[true, 'yes'], [false, 'no'], [null, 'unknown']]) {
  diagnoses.push([`setup change ${label}`, {
    sources: ['setup_error.json'], attributed: false, lines: [],
    setupError: { text: '{\r\n"error":"host failure"\r\n}', changed }, signature: null,
  }, ['Sandbox diagnosis source: setup_error.json',
    'Recent sandbox log lines only; not attributed to this probe:',
    `setup_error.json changed since snapshot: ${label}`, '> {', '> "error":"host failure"', '> }', noRepair]]);
}
diagnoses.push(['empty setup file', {
  sources: ['setup_error.json'], attributed: true, lines: [],
  setupError: { text: '', changed: true }, signature: null,
}, ['Sandbox diagnosis source: setup_error.json', 'Sandbox log lines attributed to this probe:',
  'setup_error.json changed since snapshot: yes', '> ', noRepair]]);

for (const [name, diagnosis, expected] of diagnoses) {
  test(`formatSandboxDiagnosis exact output: ${name}`, () => {
    assert.deepEqual(formatSandboxDiagnosis(diagnosis), expected);
  });
  for (const platform of ['win32', 'linux']) {
    test(`sandboxRefusal exact output: ${platform}, ${name}`, () => {
      assert.equal(sandboxRefusal(refusalResult(dead, diagnosis), platform), expectedRefusal(dead, platform, expected));
    });
  }
}

for (const diagnosis of [undefined, null, false, 'not a diagnosis']) {
  for (const platform of ['win32', 'linux']) {
    test(`sandboxRefusal exact output: ${platform}, absent diagnosis ${diagnosis}`, () => {
      assert.equal(sandboxRefusal(refusalResult(dead, diagnosis), platform), expectedRefusal(dead, platform));
    });
  }
}

for (const failure of failures) {
  test(`exact signature summary, repair, diagnosis and both refusals: ${failure.id}`, async () => {
    await withTempTree('sandbox-text-signature-', async (home) => {
      const { log } = fixture(home);
      const before = snapshotSandboxLogs({ codexHome: home, now });
      fs.writeFileSync(log, `${failure.line}\n`);
      const diagnosis = diagnoseSandbox({ codexHome: home, before, now });
      assert.deepEqual(diagnosis.signature,
        { id: failure.id, summary: failure.summary, repair: failure.repair(home) });
      const expected = [`Sandbox diagnosis source: ${log}`, 'Sandbox log lines attributed to this probe:',
        `> ${failure.line}`, failure.summary, failure.repair(home)];
      assert.deepEqual(formatSandboxDiagnosis(diagnosis), expected);
      for (const platform of ['win32', 'linux']) {
        assert.equal(sandboxRefusal(refusalResult(dead, diagnosis), platform), expectedRefusal(dead, platform, expected));
      }
    });
  });
}

test('unreadable log and setup file retain exact Unknown evidence and unknown change', async () => {
  await withTempTree('sandbox-text-unreadable-', async (home) => {
    const { log, setup } = fixture(home);
    fs.mkdirSync(log);
    fs.mkdirSync(setup);
    const before = snapshotSandboxLogs({ codexHome: home, now });
    assert.deepEqual(before.setupError, { state: 'unknown', text: `Unknown: unable to read ${setup}.` });
    const diagnosis = diagnoseSandbox({ codexHome: home, before, now });
    assert.deepEqual(diagnosis.lines, [`Unknown: unable to read ${log}.`]);
    assert.deepEqual(diagnosis.setupError, { text: `Unknown: unable to read ${setup}.`, changed: null });
    const expected = [`Sandbox diagnosis source: ${log}`, `Sandbox diagnosis source: ${setup}`,
      'Recent sandbox log lines only; not attributed to this probe:', `> Unknown: unable to read ${log}.`,
      'setup_error.json changed since snapshot: unknown', `> Unknown: unable to read ${setup}.`, noRepair];
    assert.deepEqual(formatSandboxDiagnosis(diagnosis), expected);
    for (const platform of ['win32', 'linux']) {
      assert.equal(sandboxRefusal(refusalResult(dead, diagnosis), platform), expectedRefusal(dead, platform, expected));
    }
  });
});

test('unknown baseline retains exact pre-probe Unknown evidence without attributing a signature', async () => {
  await withTempTree('sandbox-text-baseline-', async (home) => {
    const { log } = fixture(home);
    fs.writeFileSync(log, 'setup error: other failure\n');
    const before = { logs: [{ path: log, size: null }], setupError: { state: 'missing', text: null } };
    const diagnosis = diagnoseSandbox({ codexHome: home, before, now });
    const expected = [`Sandbox diagnosis source: ${log}`,
      'Recent sandbox log lines only; not attributed to this probe:', '> setup error: other failure',
      `> Unknown: pre-probe size unavailable for ${log}.`, noRepair];
    assert.deepEqual(formatSandboxDiagnosis(diagnosis), expected);
    for (const platform of ['win32', 'linux']) {
      assert.equal(sandboxRefusal(refusalResult(dead, diagnosis), platform), expectedRefusal(dead, platform, expected));
    }
  });
});

const reasons = [
  [{ error: { code: 'ETIMEDOUT' } },
    'The flagged sandbox probe timed out.', 'The control sandbox probe timed out.'],
  [{ error: { code: 'ENOENT' } },
    'The flagged sandbox probe could not start or complete.', 'The control sandbox probe could not start or complete.'],
  [{ signal: 'SIGTERM' },
    'The flagged sandbox probe was terminated by SIGTERM.', 'The control sandbox probe was terminated by SIGTERM.'],
  [{ status: 2 },
    'Codex rejected the flagged sandbox probe arguments.', 'Codex rejected the control sandbox probe arguments.'],
  [{ status: null },
    'The flagged sandbox probe returned no exit status.', 'The control sandbox probe returned no exit status.'],
];
const probeCases = reasons.flatMap(([response, flagged, control]) => [
  ['inconclusive', [response], flagged], ['inconclusive', [{ status: 1 }, response], control],
]);
probeCases.push(
  ['alive', [{ status: 0, stdout: 'codex-bridge-sandbox-ok' }], 'The Codex sandbox started a process.'],
  ['inconclusive', [{ status: 3, stdout: 'codex-bridge-sandbox-ok' }],
    'The flagged sandbox probe printed the marker but exited 3.'],
  ['inconclusive', [{ status: 1 }, { status: 0, stdout: 'codex-bridge-sandbox-ok' }],
    'This version of Codex no longer accepts the package sandbox flags.'],
  ['dead', [{ status: 1 }, { status: 1 }, { status: 0 }], dead],
);
for (const response of [{ status: 1 }, { status: 2 }, { error: { code: 'ENOENT' } },
  { error: { code: 'ETIMEDOUT' } }, { signal: 'SIGTERM' }, { status: null }]) {
  probeCases.push(['inconclusive', [{ status: 1 }, { status: 1 }, response], 'Codex CLI is unavailable.']);
}
for (const platform of ['win32', 'linux']) {
  for (const [index, [outcome, responses, reason]] of probeCases.entries()) {
    test(`probe reason and refusal exact output: ${platform}, case ${index}`, async () => {
      await withTempTree('sandbox-text-reason-', async (home) => {
        let attempt = 0;
        const result = await probeSandbox({ agent: 'codex-scout', repo: home, platform, codexHome: home,
          clock: () => now, run: () => {
            assert.ok(attempt < responses.length);
            return responses[attempt++];
          } });
        assert.equal(attempt, responses.length);
        assert.equal(result.outcome, outcome);
        assert.equal(result.reason, reason);
        assert.equal(sandboxRefusal(refusalResult(result.reason, null), platform), expectedRefusal(reason, platform));
      });
    });
  }
}

test('missing repository preserves the exact contract error', async () => {
  await withTempTree('sandbox-text-repository-', async (home) => {
    await assert.rejects(probeSandbox({ agent: 'codex-scout', platform: 'win32', codexHome: home }),
      { message: 'sandbox probe requires a repository path' });
  });
});

test('SIGNATURES and registered known-failure texts cover exactly the same ids in both directions', () => {
  const source = fs.readFileSync(new URL('../../src/home/lib/runner/sandbox-diagnosis.mjs', import.meta.url), 'utf8');
  const catalog = source.slice(source.indexOf('const SIGNATURES ='), source.indexOf('function logPath'));
  const ids = [...catalog.matchAll(/^    id: '([^']+)'/gm)].map((match) => match[1]);
  const prefix = 'sandbox-known-failure-';
  const registryIds = Object.keys(ORDER_DIAGNOSTICS).filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  assert.ok(ids.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...registryIds].sort(), [...ids].sort());
  assert.deepEqual(failures.map(({ id }) => id).sort(), [...ids].sort());
  for (const failure of failures) {
    const key = prefix + failure.id;
    assert.equal(ORDER_DIAGNOSTICS[key].category, 'host-state');
    assert.equal(orderDiagnosticMessage(key, { part: 'summary' }), failure.summary);
    const file = path.join('host-home', '.sandbox', 'deny_read_acl_state.json');
    const values = failure.id === 'deny-read-state-corrupt' ? { part: 'repair', file } : { part: 'repair' };
    assert.equal(orderDiagnosticMessage(key, values), failure.repair('host-home'));
    assert.throws(() => orderDiagnosticMessage(key, { part: 'unknown' }), /unknown .* part: unknown/);
  }
});

test('both sandbox modules are admitted without pending migration or guard opt-outs', () => {
  for (const name of ['sandbox-probe', 'sandbox-diagnosis']) {
    const file = `src/home/lib/runner/${name}.mjs`;
    assert.ok(ADMISSION_FILES.includes(file));
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
  }
});

test('D6 journals handwritten unknown parameters in an isolated child marker', async () => {
  await withTempTree('sandbox-text-parameter-', async (tree) => {
    const marker = path.join(tree, 'marker');
    const diagnostics = new URL('../../src/home/lib/order-diagnostics.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { orderDiagnosticMessage } from ${JSON.stringify(diagnostics)};
      orderDiagnosticMessage('sandbox-probe-reason', { variant: 'dead', unknown: 'handwritten sandbox text' });
    `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: marker },
      encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const directory = path.join(marker, 'order-text-violations');
    const entries = fs.readdirSync(directory).flatMap((file) =>
      fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'parameter');
    assert.equal(entries[0].builder, 'orderDiagnosticMessage');
    assert.equal(entries[0].key, 'sandbox-probe-reason');
    assert.equal(entries[0].parameter, 'unknown');
    assert.equal(entries[0].message, 'handwritten sandbox text');
    assert.notEqual(entries[0].pid, process.pid);
  });
});

for (const failure of failures) {
  test(`stale ${failure.id} keeps its exact evidence but receives NO_REPAIR`, async () => {
    await withTempTree('sandbox-text-stale-', async (home) => {
      const { log } = fixture(home);
      fs.writeFileSync(log, failure.line + '\n');
      const before = snapshotSandboxLogs({ codexHome: home, now });
      const diagnosis = diagnoseSandbox({ codexHome: home, before, now });
      assert.equal(diagnosis.signature, null);
      const expected = [`Sandbox diagnosis source: ${log}`,
        'Recent sandbox log lines only; not attributed to this probe:', `> ${failure.line}`, noRepair];
      assert.deepEqual(formatSandboxDiagnosis(diagnosis), expected);
      for (const platform of ['win32', 'linux']) {
        assert.equal(sandboxRefusal(refusalResult(dead, diagnosis), platform), expectedRefusal(dead, platform, expected));
      }
    });
  });
}

test('real probe refusals compose registered outputs without journaling host evidence as prose', async () => {
  await withTempTree('sandbox-text-outgoing-', async (tree) => {
    const marker = path.join(tree, 'marker');
    const probeUrl = new URL('../../src/home/lib/runner/sandbox-probe.mjs', import.meta.url).href;
    const recorder = new URL('../../src/home/lib/order-text-record.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import path from 'node:path';
      import { probeSandbox, sandboxRefusal } from ${JSON.stringify(probeUrl)};
      import { checkOutgoingRefusal } from ${JSON.stringify(recorder)};
      const home = ${JSON.stringify(tree)};
      const folder = path.join(home, '.sandbox');
      fs.mkdirSync(folder);
      const log = path.join(folder, 'sandbox.2026-10-10.log');
      for (const platform of ['win32', 'linux']) {
        let count = 0;
        const result = await probeSandbox({ agent: 'codex-scout', repo: home, codexHome: home, platform,
          clock: () => new Date(2026, 9, 10, 12), run: () => {
            if (count === 0) fs.appendFileSync(log, 'setup error: deny_read_acl_state.json: expected value at line 1 column 1\\n');
            return { status: ++count === 3 ? 0 : 1, stderr: 'unregistered host stderr' };
          } });
        checkOutgoingRefusal(sandboxRefusal(result, platform), 'sandbox-test');
      }
    `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: marker },
      encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(fs.existsSync(path.join(marker, 'order-text-violations')), false);
  });
});
