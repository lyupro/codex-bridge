/** Guards Plan_65 D12/D14: dry-run diagnoses share checks, collect refusals and never imply consent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../../cli/install.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { diagnosePurge, planRefusals } from '../../cli/purge-preflight.mjs';
import { liveRunLines } from '../../cli/purge-live-runs.mjs';
import { purgeDryRunLines, purgeDryRunExitCode, planLines } from '../../cli/removal-outcomes.mjs';
import { installRecordPath } from '../../cli/install-record.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const clear = () => ({ verdict: 'clear', blocked: [], unknown: [] });
const heading = 'If you confirm both questions:';

async function installedHome(t) {
  const root = makeTempTree('bridge-purge-dry-run-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'), codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'home'),
  });
  await install({ host });
  return { root, host };
}

async function snapshot(root) {
  const entries = [];
  const walk = async (relative) => {
    const target = path.join(root, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      entries.push({ relative, kind: 'link', target: await fs.readlink(target) });
    } else if (stat.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      for (const name of (await fs.readdir(target)).sort()) {
        await walk(relative ? `${relative}/${name}` : name);
      }
    } else {
      entries.push({ relative, kind: 'file', size: stat.size, bytes: await fs.readFile(target) });
    }
  };
  await walk('');
  return entries;
}

async function diagnoseReadOnly(root, host, liveRunCheck = clear) {
  const before = await snapshot(root);
  let checks = 0;
  const diagnostic = await diagnosePurge({ host, packageRoot, liveRunCheck: async () => {
    checks += 1;
    return liveRunCheck();
  } });
  assert.equal(checks, 1, 'D14 keeps a single live-run check');
  const after = await snapshot(root);
  assert.deepEqual(after, before, 'Paths, sizes, contents and link targets must stay identical');
  assert.equal(after.some((entry) => /\.installed\.json\.lock[^/]*$/.test(entry.relative)), false);
  const backups = (entries) => entries.filter((entry) => /backup/i.test(entry.relative));
  assert.deepEqual(backups(after), backups(before), 'No backup may appear');
  assert.deepEqual(Object.keys(diagnostic).sort(), ['dataFiles', 'plan', 'refusals']);
  assert.equal(Object.isFrozen(diagnostic.plan), false, 'Diagnostics do not authorize or freeze a plan');
  assert.equal(Object.isFrozen(diagnostic.plan.rows), false);
  return diagnostic;
}

function assertConditional(lines) {
  const index = lines.indexOf(heading);
  assert.ok(index >= 0);
  assert.equal(lines.slice(0, index).some((line) => line.startsWith('Would remove')), false);
  assert.match(lines.at(-1), /^Run artifacts in .* are outside uninstall and stay\.$/);
}

test('a clean home lists both future consents and sorted data before conditional removals, read-only', async (t) => {
  const { root, host } = await installedHome(t);
  const diagnostic = await diagnoseReadOnly(root, host);
  assert.deepEqual(diagnostic.refusals, []);
  assert.deepEqual(diagnostic.dataFiles, ['config.json', 'conventions.md']);
  const lines = purgeDryRunLines(diagnostic, { host });
  const question = `A real purge would ask two questions: whether any other host uses ${host.brandRoot}`;
  assert.equal(lines[0], `${question}, and whether to delete your data in it.`);
  assert.equal(lines[1], 'Your data it would ask about: config.json, conventions.md');
  assert.equal(lines[2], heading);
  assert.deepEqual(lines.slice(3), planLines(diagnostic.plan, { host }));
  assert.ok(lines.slice(3).some((line) => line.startsWith('Would remove')));
  assertConditional(lines);
  assert.equal(purgeDryRunExitCode(diagnostic), 0);
});

test('blocked live runs and another recorded owner are both diagnosed without writing', async (t) => {
  const { root, host } = await installedHome(t);
  const other = resolveHost({
    host: path.join(root, 'other-host'), codexHome: path.join(root, 'other-codex-home'), brandRoot: host.brandRoot,
  });
  await install({ host: other });
  const liveRuns = { verdict: 'blocked', blocked: [{ runDir: 'live', stop: 'stop live' }], unknown: [] };
  const diagnostic = await diagnoseReadOnly(root, host, () => liveRuns);
  const ownerLine = `${normalizeRepoPath(other.root)} is recorded as using ${host.brandRoot}; uninstall it first.`;
  assert.deepEqual(diagnostic.refusals, [...liveRunLines(liveRuns), ownerLine]);
  const lines = purgeDryRunLines(diagnostic, { host });
  assert.deepEqual(lines.slice(0, diagnostic.refusals.length + 1),
    ['A real purge would refuse:', ...diagnostic.refusals.map((line) => `  ${line}`)]);
  assertConditional(lines);
  assert.equal(purgeDryRunExitCode(diagnostic), 1);
});

test('a corrupt record reports its plan refusal without writing', async (t) => {
  const { root, host } = await installedHome(t);
  await fs.writeFile(installRecordPath(host), '{');
  const diagnostic = await diagnoseReadOnly(root, host);
  assert.deepEqual(diagnostic.refusals, [
    `The installation record of ${host.brandRoot} is unreadable: purge cannot tell who uses this home.`,
  ]);
  assertConditional(purgeDryRunLines(diagnostic, { host }));
  assert.equal(purgeDryRunExitCode(diagnostic), 1);
});

test('an unreadable home reports only its plan refusal without writing', async (t) => {
  const { root, host } = await installedHome(t);
  await fs.writeFile(installRecordPath(host), '{');
  await fs.rename(host.brandRoot, path.join(root, 'saved-home'));
  await fs.writeFile(host.brandRoot, 'not a directory');
  const diagnostic = await diagnoseReadOnly(root, host);
  assert.equal(diagnostic.plan.homeRoot, 'error');
  assert.deepEqual(diagnostic.refusals, [`Could not read ${host.brandRoot}: purge cannot inventory the home.`]);
  assertConditional(purgeDryRunLines(diagnostic, { host }));
  assert.equal(purgeDryRunExitCode(diagnostic), 1);
});

test('a missing home reports nothing to purge and artifacts, without questions or writing', async (t) => {
  const { root, host } = await installedHome(t);
  const missingHost = { ...host, brandRoot: path.join(root, 'missing-home') };
  const diagnostic = await diagnoseReadOnly(root, missingHost);
  assert.equal(diagnostic.plan.homeRoot, 'missing');
  assert.deepEqual(diagnostic.refusals, []);
  assert.deepEqual(diagnostic.dataFiles, []);
  const lines = purgeDryRunLines(diagnostic, { host: missingHost });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `Nothing to purge: ${missingHost.brandRoot} does not exist.`);
  assert.match(lines[1], /^Run artifacts in /);
  assert.equal(lines.some((line) => line.includes('questions')), false);
  assert.equal(purgeDryRunExitCode(diagnostic), 0);
});

test('D4 names files behind a home junction under the consent heading and exits 1, read-only', async (t) => {
  const { root, host } = await installedHome(t);
  const folder = path.join(host.brandRoot, 'lib/runner');
  const outside = path.join(root, 'outside-runner');
  await fs.rename(folder, outside);
  await fs.symlink(outside, folder, 'junction');
  const diagnostic = await diagnoseReadOnly(root, host);
  assert.deepEqual(diagnostic.refusals, []);
  const linkedRows = diagnostic.plan.rows.filter((row) => row.relative.startsWith('lib/runner/'));
  assert.ok(linkedRows.length > 0);
  const lines = purgeDryRunLines(diagnostic, { host });
  assertConditional(lines);
  for (const row of linkedRows) {
    const index = lines.indexOf(`Would leave brand/${row.relative} (link at lib/runner)`);
    assert.ok(index > lines.indexOf(heading), row.relative);
  }
  assert.equal(purgeDryRunExitCode(diagnostic), 1);
});

test('pure rendering keeps all removals conditional, including with refusals or no data', () => {
  const host = { root: 'host', brandRoot: 'home' };
  const plan = {
    homeRoot: 'present', blocked: false,
    rows: [{ relative: 'config.json', id: null, action: 'remove', removal: 'purge-only' }],
    record: { operation: 'delete' },
  };
  for (const refusals of [[], ['live refusal']]) {
    const diagnostic = { refusals, plan, dataFiles: [] };
    const lines = purgeDryRunLines(diagnostic, { host });
    assertConditional(lines);
    assert.equal(lines.some((line) => line.startsWith('Your data')), false);
    assert.equal(purgeDryRunExitCode(diagnostic), refusals.length ? 1 : 0);
  }
  const unreadable = { ...plan, homeRoot: 'error', recordState: 'corrupt' };
  assert.deepEqual(planRefusals(unreadable, host), ['Could not read home: purge cannot inventory the home.']);
  const diagnostic = { refusals: ['live refusal'], plan: { ...plan, homeRoot: 'missing' }, dataFiles: [] };
  const lines = purgeDryRunLines(diagnostic, { host });
  assert.equal(lines[0], 'A real purge would refuse:');
  assert.equal(lines.some((line) => line.startsWith('Nothing to purge')), false);
  assertConditional(lines);
  assert.equal(purgeDryRunExitCode(diagnostic), 1);
});
