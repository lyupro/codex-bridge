/** Verifies user, project, and explicit Claude Code host resolution. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';

test('user scope resolves beneath the supplied home directory', () => {
  const host = resolveHost({ homedir: path.join(os.tmpdir(), 'bridge-home') });
  assert.equal(host.root, path.join(os.tmpdir(), 'bridge-home', '.claude'));
  assert.equal(host.agentsDir, path.join(host.root, 'agents', 'codex'));
  assert.equal(host.commandsDir, path.join(host.root, 'commands', 'codex'));
  assert.equal(host.settingsPath, path.join(host.root, 'settings.json'));
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
  const host = resolveHost({ scope: 'ignored', host: explicit, cwd: path.parse(explicit).root });
  assert.equal(host.root, path.resolve(explicit));
  assert.equal(host.scope, 'host');
});

test('unknown scope is rejected', () => {
  assert.throws(() => resolveHost({ scope: 'global' }), /unknown scope/);
});
