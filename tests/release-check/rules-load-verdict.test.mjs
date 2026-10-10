/** Guards exact-project proof and attempt persistence because Plan_64 D12/D13 and the 2026-10-10 manual run require missing evidence to block a release without claiming failure. */
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readJsonFile } from '../../src/home/lib/json-file.mjs';
import { withTempTree } from '../temp-tree.mjs';
import { resolveTargets, preflightTarget, REQUIRED_FLAGS } from '../../scripts/release-check/rules-load-targets.mjs';
import { DEFAULT_ATTEMPT_PATH, exitCodeFor, judgeCell, writeAttempt } from '../../scripts/release-check/rules-load-verdict.mjs';

const expectedPath = path.resolve('fake-project', '.claude', 'rules', 'codex-bridge', 'core.md');
const frozenSha256 = 'a'.repeat(64);
const version = '2.1.999';
const sessionId = 'project-session';
const load = { path: expectedPath, loadReason: 'session_start', sha256: frozenSha256, at: '2026-10-10T21:00:00Z' };

function inputs(overrides = {}) {
  return {
    witness: { sessions: { [sessionId]: { loads: [load], transcriptPath: '/fake/transcript', cwd: path.dirname(expectedPath) } } },
    expectedPath, frozenSha256, sessionId, transcriptVersion: version, preflightVersion: version,
    ...overrides,
  };
}

function withLoads(loads) {
  return { sessions: { [sessionId]: { loads } } };
}

test('matching project witness and versions verify the cell', () => {
  const result = judgeCell(inputs());
  assert.equal(result.outcome, 'verified');
  assert.equal(typeof result.reason, 'string');
});

test('broken invariant precedes corrupt witness and all missing evidence', () => {
  for (const invariant of ['changed core bytes', 'changed install snapshot', 'isolation escape']) {
    assert.deepEqual(judgeCell(inputs({ invariant, witness: { corrupt: true }, transcriptVersion: undefined })),
      { outcome: 'failed', reason: invariant });
  }
});

test('corrupt witness precedes session or load absence', () => {
  const result = judgeCell(inputs({ witness: { corrupt: true, sessions: {} } }));
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /corrupt/);
});

test('missing witness, session or exact session_start load is inconclusive', () => {
  for (const witness of [undefined, { sessions: {} }, { sessions: { other: { loads: [load] } } },
    withLoads([]), withLoads([{ ...load, loadReason: 'manual' }])]) {
    const result = judgeCell(inputs({ witness, transcriptVersion: undefined }));
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.reason, /session_start/);
  }
});

test('user core with the correct hash and ancestor CLAUDE.md cannot replace project core', () => {
  for (const otherPath of [path.resolve('fake-user', '.claude', 'rules', 'codex-bridge', 'core.md'),
    path.resolve('CLAUDE.md')]) {
    assert.equal(judgeCell(inputs({ witness: withLoads([{ ...load, path: otherPath }]) })).outcome, 'inconclusive');
  }
});

test('path comparison normalizes slashes and trailing slashes', () => {
  const witness = withLoads([{ ...load, path: expectedPath.replaceAll('\\', '/') + '///' }]);
  assert.equal(judgeCell(inputs({ witness, expectedPath: expectedPath.replaceAll('/', '\\') + '\\' })).outcome, 'verified');
});

test('path comparison folds case only on win32', () => {
  const witness = withLoads([{ ...load, path: expectedPath.toUpperCase() }]);
  assert.equal(judgeCell(inputs({ witness })).outcome, process.platform === 'win32' ? 'verified' : 'inconclusive');
});

test('missing or different SHA-256 fails before missing or mismatched transcript version', () => {
  for (const sha256 of [undefined, null, 'b'.repeat(64)]) {
    const result = judgeCell(inputs({ witness: withLoads([{ ...load, sha256 }]), transcriptVersion: undefined }));
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason, /SHA-256/);
  }
});

test('D15 oversized project core fails before hash comparison and transcript version checks', () => {
  for (const sha256 of [null, frozenSha256]) {
    const witness = withLoads([{ ...load, sha256, hashSkippedReason: 'core-too-large' }]);
    assert.deepEqual(judgeCell(inputs({ witness, transcriptVersion: undefined })), {
      outcome: 'failed', reason: 'installed core exceeds the package size ceiling',
    });
  }
});

test('D15 oversized markers do not change invariant, corrupt-witness or exact-load precedence', () => {
  const oversized = { ...load, sha256: null, hashSkippedReason: 'core-too-large' };
  const witness = withLoads([oversized]);
  assert.deepEqual(judgeCell(inputs({ witness, invariant: 'earlier invariant' })), {
    outcome: 'failed', reason: 'earlier invariant',
  });
  assert.deepEqual(judgeCell(inputs({ witness: { ...witness, corrupt: true } })), {
    outcome: 'failed', reason: 'Load witness is corrupt.',
  });
  for (const unrelated of [{ ...oversized, path: '/other/core.md' }, { ...oversized, loadReason: 'manual' }]) {
    assert.equal(judgeCell(inputs({ witness: withLoads([unrelated]) })).outcome, 'inconclusive');
    assert.equal(judgeCell(inputs({ witness: withLoads([unrelated, load]) })).outcome, 'verified');
  }
  assert.equal(judgeCell(inputs({ witness: withLoads([{ ...load, hashSkippedReason: 'another-reason' }]) })).outcome, 'verified');
});

test('missing transcript version is inconclusive after a matching witness', () => {
  for (const transcriptVersion of [undefined, null, '']) {
    const result = judgeCell(inputs({ transcriptVersion }));
    assert.equal(result.outcome, 'inconclusive');
    assert.match(result.reason, /version is missing/);
  }
});

test('changed transcript version is inconclusive', () => {
  const result = judgeCell(inputs({ transcriptVersion: '2.1.998' }));
  assert.equal(result.outcome, 'inconclusive');
  assert.match(result.reason, /preflight version/);
});

test('unrelated loads do not hide the matching project session_start load', () => {
  const witness = withLoads([
    { ...load, path: '/fake-user/core.md', sha256: 'wrong' },
    { ...load, loadReason: 'manual', sha256: 'wrong' },
    load,
  ]);
  assert.equal(judgeCell(inputs({ witness })).outcome, 'verified');
});

test('session IDs such as __proto__ are data and inherited sessions never count', () => {
  const inherited = Object.create({ [sessionId]: { loads: [load] } });
  assert.equal(judgeCell(inputs({ witness: { sessions: inherited } })).outcome, 'inconclusive');
  assert.equal(judgeCell(inputs({ sessionId: '__proto__', witness: {
    sessions: { ['__proto__']: { loads: [load] } },
  } })).outcome, 'verified');
});

test('same-version CLI and extension remain two independently verified cells', () => {
  const executable = path.resolve('fake-host', 'claude.exe');
  const targets = resolveTargets({ env: {}, vscodeExecutable: executable, resolveOnPath: () => executable, exists: () => true });
  const calls = [];
  const cells = Object.fromEntries(Object.entries(targets).map(([role, target]) => {
    const result = preflightTarget({ target, run: (_executable, args) => {
      calls.push([role, args[0]]);
      return { status: 0, stdout: args[0] === '--version' ? version : REQUIRED_FLAGS.join('\n') };
    } });
    assert.equal(result.ok, true);
    return [role, judgeCell(inputs({ preflightVersion: result.version }))];
  }));
  assert.deepEqual(Object.keys(cells), ['cli', 'vscode']);
  assert.deepEqual(calls, [['cli', '--version'], ['cli', '--help'], ['vscode', '--version'], ['vscode', '--help']]);
  assert.equal(exitCodeFor(cells), 0);
});

test('exit-code failure takes precedence over inconclusive and incomplete matrices', () => {
  for (const cells of [[{ outcome: 'failed' }], [{ outcome: 'inconclusive' }, { outcome: 'failed' }],
    [{ outcome: 'failed' }, { outcome: 'verified' }]]) {
    assert.equal(exitCodeFor(cells), 1);
  }
});

test('exit code blocks inconclusive cells and matrices with fewer than two cells', () => {
  for (const cells of [[], [{ outcome: 'verified' }], [{ outcome: 'inconclusive' }, { outcome: 'verified' }]]) {
    assert.equal(exitCodeFor(cells), 2);
  }
  assert.equal(exitCodeFor({}), 2);
  assert.equal(exitCodeFor({ cli: { outcome: 'verified' } }), 2);
  assert.equal(exitCodeFor([{ outcome: 'verified' }, { outcome: 'verified' }]), 0);
});

test('attempt round trip creates directories, replaces the old record and leaves no temporary file', async () => {
  await withTempTree('rules-load-attempt-', async (root) => {
    assert.equal(DEFAULT_ATTEMPT_PATH, 'docs/audits/release-checks/rules-load-claude.json');
    const file = path.join(root, DEFAULT_ATTEMPT_PATH);
    const cell = {
      ...judgeCell(inputs()), executable: path.resolve('fake-host', 'claude.exe'), version,
      sha256: frozenSha256, expectedPath, sessionId,
    };
    const attempt = {
      schema: 1, attemptId: 'attempt-one', startedAt: '2026-10-10T21:00:00Z', finishedAt: '2026-10-10T21:01:00Z',
      candidate: { revision: 'fixture-revision', packageVersion: '0.0.0' }, cells: { cli: cell, vscode: cell },
    };
    await writeAttempt({ file, attempt });
    assert.deepEqual(await readJsonFile(file), attempt);
    const replacement = { ...attempt, attemptId: 'attempt-two' };
    await writeAttempt({ file, attempt: replacement });
    assert.deepEqual(await readJsonFile(file), replacement);
    assert.deepEqual(await readdir(path.dirname(file)), [path.basename(file)]);
  });
});

test('attempt write errors propagate and temporary files are cleaned up', async () => {
  await withTempTree('rules-load-attempt-error-', async (root) => {
    const file = path.join(root, 'attempt.json');
    const attempt = { schema: 1 };
    attempt.circular = attempt;
    await assert.rejects(writeAttempt({ file, attempt }), /circular/i);
    assert.deepEqual(await readdir(root), []);
    const directory = path.join(root, 'directory');
    await mkdir(directory);
    await assert.rejects(writeAttempt({ file: directory, attempt: { schema: 1 } }));
    // Rename over a directory must fail rather than turn an inaccessible artifact into "absent".
    assert.deepEqual(await readdir(root), ['directory']);
  });
});
