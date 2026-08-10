/** Verifies user, project, and explicit Claude Code host resolution. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';

function assertBrandPaths(host, brandRoot) {
  assert.equal(host.brandRoot, brandRoot);
  assert.equal(host.brandHooksDir, path.join(brandRoot, 'hooks'));
  assert.equal(host.brandRunnerDir, path.join(brandRoot, 'lib'));
  assert.equal(host.brandConfigPath, path.join(brandRoot, 'config.json'));
  assert.equal(host.brandConventionsPath, path.join(brandRoot, 'conventions.md'));
  assert.equal(host.brandInstallRecordPath, path.join(brandRoot, '.installed.json'));
}

test('user scope resolves beneath the supplied home directory', () => {
  const homedir = path.join(os.tmpdir(), 'bridge-home');
  const host = resolveHost({ homedir });
  assert.equal(host.root, path.join(homedir, '.claude'));
  assert.equal(host.agentsDir, path.join(host.root, 'agents', 'codex'));
  assert.equal(host.commandsDir, path.join(host.root, 'commands', 'codex'));
  assert.equal(host.settingsPath, path.join(host.root, 'settings.json'));
  assertBrandPaths(host, path.join(homedir, '.lyupro', '.codex-bridge'));
  assert.equal(fs.existsSync(host.brandRoot), false);
  assert.equal(host.scope, 'user');
});

test('project scope finds the repository root above cwd', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const nested = path.join(root, 'one', 'two');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveHost({ scope: 'project', cwd: nested }).root, path.join(root, '.claude'));
});

test('explicit host overrides both scope choices', () => {
  const explicit = path.join(os.tmpdir(), 'bridge-explicit');
  const codexHome = path.join(os.tmpdir(), 'bridge-codex-home');
  const host = resolveHost({ scope: 'ignored', host: explicit, cwd: path.parse(explicit).root, codexHome });
  assert.equal(host.root, path.resolve(explicit));
  assert.equal(host.codexRulesDir, path.join(codexHome, 'rules'));
  assertBrandPaths(host, path.join(os.homedir(), '.lyupro', '.codex-bridge'));
  assert.equal(host.scope, 'host');
});

test('brand root override is independent from an explicit host root', () => {
  const homedir = path.join(os.tmpdir(), 'bridge-brand-home');
  const explicit = path.join(os.tmpdir(), 'bridge-brand-host');
  const brandRoot = path.join(os.tmpdir(), 'bridge-brand-root');
  const host = resolveHost({ homedir, host: explicit, brandRoot });
  assert.equal(host.root, path.resolve(explicit));
  assertBrandPaths(host, path.resolve(brandRoot));
});

test('Codex rules use CODEX_HOME independently of the Claude Code host', (t) => {
  const previous = process.env.CODEX_HOME;
  const codexHome = path.join(os.tmpdir(), 'bridge-env-codex-home');
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  const host = resolveHost({ host: path.join(os.tmpdir(), 'unrelated-claude-host') });
  assert.equal(host.codexRulesDir, path.join(codexHome, 'rules'));
});

test('Codex rules default beneath the supplied home directory', (t) => {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous !== undefined) process.env.CODEX_HOME = previous;
  });
  const homedir = path.join(os.tmpdir(), 'bridge-default-codex-home');
  assert.equal(resolveHost({ homedir }).codexRulesDir, path.join(homedir, '.codex', 'rules'));
});

test('unknown scope is rejected', () => {
  assert.throws(() => resolveHost({ scope: 'global' }), /unknown scope/);
});
