/** Guards Plan_77 B7 storage provenance, retired overrides, and doctor failures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runsRootCheck, projectRunsCheck, liveRunsCheck } from '../../cli/doctor-runs.mjs';
import { resolveBrandHome } from '../../src/home/lib/brand-home.mjs';
import { runsRootResolution, staleOverrideRefusal } from '../../src/home/lib/runner/runs-root.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t, source = 'default') {
  const dir = makeTempTree('doctor-runs-root-');
  t.after(() => removeTempTree(dir));
  return {
    root: path.join(dir, 'runs'), source,
    legacyRoot: path.join(dir, 'legacy'), homeRoot: path.join(dir, 'runs'),
    retired: [], staleOverride: null,
  };
}

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function prefix(resolution) {
  return path.resolve(resolution.root) + ' (' + resolution.source + ')';
}

for (const source of ['default', 'moved', 'CODEX_RUNS_ROOT']) {
  test(source + ' without a foreign repository is healthy', (t) => {
    const resolution = fixture(t, source);
    let probes = 0;
    assert.deepEqual(runsRootCheck({ resolution, gitTop(dir) {
      probes += 1;
      assert.equal(dir, path.resolve(resolution.root));
      return null;
    } }), { key: 'runsRoot', status: 'ok', value: prefix(resolution) });
    assert.equal(probes, 1);
  });
}

test('legacy reports the pending move instead of an additional foreign-git warning', (t) => {
  const resolution = fixture(t, 'legacy');
  assert.deepEqual(runsRootCheck({ resolution, gitTop() { assert.fail('legacy needs no git probe'); } }), {
    key: 'runsRoot', status: 'warn',
    value: prefix(resolution) + ' — move pending: run codex-bridge runs move when no other project is running.',
  });
});

test('moved reports a leftover legacy directory before probing git', (t) => {
  const resolution = fixture(t, 'moved');
  fs.mkdirSync(resolution.legacyRoot);
  assert.deepEqual(runsRootCheck({ resolution, gitTop() { assert.fail('leftover warning has priority'); } }), {
    key: 'runsRoot', status: 'warn',
    value: prefix(resolution) + ' — the old folder ' + resolution.legacyRoot + ' still exists; codex-bridge runs move removes it.',
  });
});

test('a leftover legacy file does not count as a directory', (t) => {
  const resolution = fixture(t, 'moved');
  fs.writeFileSync(resolution.legacyRoot, 'file');
  assert.equal(runsRootCheck({ resolution, gitTop: () => null }).status, 'ok');
});

test('a stale override fails before pending-move and foreign-git diagnostics', (t) => {
  const resolution = fixture(t, 'CODEX_RUNS_ROOT');
  resolution.root = path.join(resolution.legacyRoot, 'project');
  resolution.staleOverride = resolution.legacyRoot;
  resolution.retired = [resolution.legacyRoot];
  const result = runsRootCheck({ resolution, gitTop() { assert.fail('retired root must not be probed'); } });
  assert.deepEqual(result, {
    key: 'runsRoot', status: 'fail',
    value: prefix(resolution) + ' — ' + staleOverrideRefusal(resolution),
  });
  assert.match(result.value, /CODEX_RUNS_ROOT points under a retired runs root/);
  assert.match(result.value, /No path was remapped/);
});

for (const source of ['default', 'moved', 'CODEX_RUNS_ROOT']) {
  test(source + ' warns when records land in a foreign repository', (t) => {
    const resolution = fixture(t, source);
    const top = path.dirname(resolution.root);
    assert.deepEqual(runsRootCheck({ resolution, gitTop: () => top }), {
      key: 'runsRoot', status: 'warn',
      value: prefix(resolution) + ' — run records land in the git repository ' + top
        + ', which is not their own; they accumulate there uncommitted.',
    });
  });
}

test('a repository rooted at the run store is its own, using normalized paths', (t) => {
  const resolution = fixture(t, 'CODEX_RUNS_ROOT');
  const top = path.join(resolution.root, '..', path.basename(resolution.root)) + path.sep;
  assert.equal(runsRootCheck({ resolution, gitTop: () => top }).status, 'ok');
  if (process.platform === 'win32') {
    assert.equal(runsRootCheck({ resolution, gitTop: () => top.toUpperCase() }).status, 'ok');
  }
});

test('a repository rooted at the brand home is its own, not just resolution.homeRoot', (t) => {
  const resolution = fixture(t, 'CODEX_RUNS_ROOT');
  const brandRoot = resolveBrandHome().root;
  assert.notEqual(resolution.homeRoot, brandRoot);
  assert.equal(runsRootCheck({ resolution, gitTop: () => brandRoot + path.sep }).status, 'ok');
  if (process.platform === 'win32') {
    assert.equal(runsRootCheck({ resolution, gitTop: () => brandRoot.toUpperCase() }).status, 'ok');
  }
});

test('the default git probe treats a missing root as healthy storage not yet created', (t) => {
  const resolution = fixture(t);
  assert.equal(fs.existsSync(resolution.root), false);
  assert.deepEqual(runsRootCheck({ resolution }), { key: 'runsRoot', status: 'ok', value: prefix(resolution) });
});

test('a resolution throw becomes a fail check with its original message', () => {
  const message = 'corrupt move record';
  assert.deepEqual(runsRootCheck({ get resolution() { throw new Error(message); } }), {
    key: 'runsRoot', status: 'fail', value: message,
  });
});

test('a corrupt move record fails default resolution and keeps all doctor run diagnostics', async (t) => {
  const resolution = fixture(t);
  const brandRoot = path.dirname(resolution.root);
  setEnv(t, 'CODEX_BRIDGE_HOME', brandRoot);
  fs.mkdirSync(path.join(brandRoot, 'state'));
  fs.writeFileSync(path.join(brandRoot, 'state', 'runs-root.json'), '{invalid JSON');
  let message;
  assert.throws(() => runsRootResolution(), (err) => { message = err.message; return true; });
  assert.deepEqual(runsRootCheck(), { key: 'runsRoot', status: 'fail', value: message });
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'runsRoot'), {
    key: 'runsRoot', status: 'fail', value: message,
  });
  assert.equal(result.checks.find((item) => item.key === 'projectRuns').status, 'fail');
  assert.equal(result.checks.find((item) => item.key === 'liveRuns').status, 'warn');
  assert.equal(result.exitCode, 1);
});

test('project and live checks use the supplied root rather than a fresh env override', (t) => {
  const resolution = fixture(t);
  fs.mkdirSync(resolution.root);
  setEnv(t, 'CODEX_RUNS_ROOT', path.join(path.dirname(resolution.root), 'elsewhere'));
  const project = projectRunsCheck(resolution);
  assert.equal(project.key, 'projectRuns');
  assert.equal(project.status, 'ok');
  assert.ok(project.value.startsWith(resolution.root + path.sep), project.value);
  assert.deepEqual(liveRunsCheck(resolution), {
    key: 'liveRuns', status: 'ok', value: '0 runs working right now',
  });
});

test('doctor foreign-repository warnings preserve the existing healthy exit code', async (t) => {
  setEnv(t, 'CODEX_RUNS_ROOT', path.join(process.cwd(), 'cli'));
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const root = result.checks.find((item) => item.key === 'runsRoot');
  assert.equal(root.status, 'warn');
  assert.match(root.value, /which is not their own; they accumulate there uncommitted/);
  assert.equal(result.exitCode, 0);
});
