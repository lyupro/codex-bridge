/** Guards the maintainer-only command boundary because Plan_64 D14 excludes release-check scripts from the published package. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseJsonText } from '../../src/home/lib/json-file.mjs';
import { makeTempTree } from '../temp-tree.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('npm dry-run excludes release-check scripts while retaining the shipped test runner', () => {
  const cache = makeTempTree('release-check-pack-cache-');
  {
    // D14: run npm's JS entry on Windows, avoiding a .cmd shim and any shell interpretation.
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const command = process.platform === 'win32' ? process.execPath : 'npm';
    const args = [...(process.platform === 'win32' ? [npmCli] : []), 'pack', '--dry-run', '--json'];
    const result = spawnSync(command, args, {
      cwd: repositoryRoot, shell: false, windowsHide: true, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, npm_config_cache: cache },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const packed = parseJsonText('npm pack --dry-run --json', result.stdout);
    assert.equal(packed.length, 1);
    const files = packed[0].files.map((entry) => entry.path.replaceAll('\\', '/'));
    assert.ok(files.includes('scripts/run-tests.mjs'));
    assert.equal(files.some((file) => file.startsWith('scripts/release-check/')), false);
  }
});
