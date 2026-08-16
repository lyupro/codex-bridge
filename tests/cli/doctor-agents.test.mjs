/** Verifies the two public prerequisites used by dispatcher command blocks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { parseFrontmatter } from '../../cli/frontmatter.mjs';
import { recordTarget } from '../../cli/manifest.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';

const bridgeProbe = () => ({ available: true, value: 'codex-bridge 0.1.0' });

test('doctor confirms installed agent definitions match the package tree', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'agents'), {
    key: 'agents',
    status: 'ok',
    value: '3 installed agent definition(s) match this package',
  });
  assert.equal(result.checks.find((item) => item.key === 'command').status, 'ok');
});

test('doctor renders agent drift as an unbracketed update command', async (t) => {
  const { host, record } = await installedFixture(t);
  const agent = record.files.find((file) => file.path.endsWith('codex-build.md'));
  await fs.appendFile(recordTarget(host, agent), '\nlocal drift\n');
  const rendered = renderDoctor(await diagnose({
    host,
    codexProbe,
    bridgeProbe,
    currentPackage: ownPackage,
  }));
  assert.match(rendered, /^Installed agent definitions differ.*codex-build\.md.*codex-bridge update --force$/m);
  assert.doesNotMatch(rendered, /^\[(?:ok|warn)] agents:/m);
});

// Drift was advisory until a checklist run planted the pre-Plan_41 invocation — a file path instead
// of the package command — in an installed definition. doctor stayed exit 0 while every delegation
// would have stopped on a permission prompt, so a script could call that host healthy.
test('doctor fails when an installed agent drifts from the package', async (t) => {
  const { host, record } = await installedFixture(t);
  const agent = record.files.find((file) => file.path.endsWith('codex-scout.md'));
  await fs.appendFile(recordTarget(host, agent), '\nnode "C:/x/run-codex.mjs" --agent codex-scout\n');
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  assert.equal(result.checks.find((item) => item.key === 'agents').status, 'fail');
});

test('doctor fails when an installed agent has unreadable frontmatter', async (t) => {
  const { host, record } = await installedFixture(t);
  const agent = record.files.find((file) => file.path.endsWith('codex-build.md'));
  const target = recordTarget(host, agent);
  const content = await fs.readFile(target, 'utf8');
  const description = parseFrontmatter(content).description;
  await fs.writeFile(target, content.replace(/^description:.*$/m, `description: ${description}`));

  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  const agents = result.checks.find((item) => item.key === 'agents');
  assert.equal(result.exitCode, 1);
  assert.equal(agents.status, 'fail');
  assert.match(agents.value, /codex-build\.md.*codex-bridge update --force/);
});

test('doctor fails when an installed agent name does not match its type', async (t) => {
  const { host, record } = await installedFixture(t);
  const agent = record.files.find((file) => file.path.endsWith('codex-build.md'));
  const target = recordTarget(host, agent);
  const content = await fs.readFile(target, 'utf8');
  await fs.writeFile(target, content.replace(/^name:.*$/m, 'name: codex-review'));

  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  const agents = result.checks.find((item) => item.key === 'agents');
  assert.equal(result.exitCode, 1);
  assert.equal(agents.status, 'fail');
  assert.match(agents.value, /codex-build\.md.*expected "codex-build".*codex-bridge update --force/);
});

test('doctor names the install command when codex-bridge is absent from PATH', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({
    host,
    codexProbe,
    bridgeProbe: () => ({ available: false, value: 'not found' }),
    currentPackage: ownPackage,
  });
  const rendered = renderDoctor(result);
  assert.equal(result.checks.find((item) => item.key === 'command').status, 'warn');
  assert.match(rendered, /^codex-bridge does not resolve on PATH.*npm i -g @lyupro\/codex-bridge$/m);
  assert.doesNotMatch(rendered, /^\[(?:ok|warn)] command:/m);
});
