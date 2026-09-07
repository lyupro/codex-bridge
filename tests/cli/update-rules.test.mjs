/** The Codex rules file across update: outdated, missing, hand-edited, and unrecorded. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { fileFingerprint, installRecordPath, readInstallRecord, rulesPlan } from '../../cli/manifest.mjs';
import { targetMatches } from '../../cli/copy.mjs';
import { update } from '../../cli/update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

async function fixture(t) {
  const root = makeTempTree('bridge-update-rules-');
  t.after(() => removeTempTree(root));
  // Naming the Codex home is not optional: without it the installed rules land in the real one.
  return {
    root,
    host: resolveHost({
      host: path.join(root, 'host'),
      codexHome: path.join(root, 'codex-home'),
      brandRoot: path.join(root, 'brand'),
    }),
  };
}

async function packageFixture(root, name, { version = '0.0.0' } = {}) {
  const packageRoot = path.join(root, name);
  await fs.cp(path.join(ROOT, 'src'), path.join(packageRoot, 'src'), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  manifest.version = version;
  await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}
`);
  return packageRoot;
}

test('outdated recorded rules are updated from the current package', async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-rules-package');
  const oldRule = rulesPlan(host, oldPackage);
  await fs.writeFile(oldRule.source, 'old package rules\n');
  await install({ host, packageRoot: oldPackage });
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.equal(await targetMatches({ ...rulesPlan(host), processing: 'copy' }, host.brandRoot), true);
});

test('missing rules stop update then --force restores them by full path', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rule = rulesPlan(host);
  await fs.rm(rule.target);
  const refused = await update({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(rule.target.replaceAll('\\', '\\\\')));
  const forced = await update({ host, force: true });
  assert.equal(forced.exitCode, 0);
  assert.equal(await targetMatches({ ...rule, processing: 'copy' }, host.brandRoot), true);
});

test('manually modified rules stop update and --force overwrites them', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rule = rulesPlan(host);
  await fs.writeFile(rule.target, 'manual operator rules\n');
  const refused = await update({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(rule.target.replaceAll('\\', '\\\\')));
  assert.match(refused.output, /--force/);
  assert.equal(await fs.readFile(rule.target, 'utf8'), 'manual operator rules\n');
  const forced = await update({ host, force: true });
  assert.equal(forced.exitCode, 0);
  assert.equal(await targetMatches({ ...rule, processing: 'copy' }, host.brandRoot), true);
});

test('a legacy record without rules adds and records the current rules', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rule = rulesPlan(host);
  const recordPath = installRecordPath(host);
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  delete legacy.rules;
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  await fs.writeFile(rule.target, 'unrecorded legacy rules\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.equal(await targetMatches({ ...rule, processing: 'copy' }, host.brandRoot), true);
  const current = await readInstallRecord(host);
  assert.equal(current.rules.path, rule.target);
  assert.equal(current.rules.fingerprint, await fileFingerprint(rule.target));
});
