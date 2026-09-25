import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { copyPlannedFile } from '../../cli/copy.mjs';
import { createHomeWriter } from '../../src/home/lib/home-write.mjs';
import { withTempTree } from '../temp-tree.mjs';

function planned(source, target) {
  return { source, target, processing: 'copy' };
}

test('an install-image member is written through the home adapter without a temporary left behind', async () => {
  await withTempTree('copy-image-', async (root) => {
    const home = path.join(root, 'home');
    const source = path.join(root, 'source.mjs');
    const relativePath = 'agents/codex-bridge/agent.mjs';
    const target = path.join(home, relativePath);
    await fs.writeFile(source, 'image member');
    const writer = createHomeWriter({ root: home, imageMembers: [relativePath] });

    await copyPlannedFile(planned(source, target), home, { writer, id: 'install-image' });

    assert.equal(await fs.readFile(target, 'utf8'), 'image member');
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['agent.mjs']);
  });
});

test('a home target outside the declared image members is refused before creation', async () => {
  await withTempTree('copy-undeclared-', async (root) => {
    const home = path.join(root, 'home');
    const source = path.join(root, 'source.mjs');
    const target = path.join(home, 'agents', 'unexpected.mjs');
    await fs.writeFile(source, 'must not be copied');
    const writer = createHomeWriter({ root: home, imageMembers: ['agents/declared.mjs'] });

    await assert.rejects(
      copyPlannedFile(planned(source, target), home, { writer, id: 'install-image' }),
      (error) => error.code === 'EHOMEREGISTRY',
    );
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  });
});

test('the raw route writes a target beyond the package home', async () => {
  await withTempTree('copy-outside-', async (root) => {
    const home = path.join(root, 'home');
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'host', 'agents', 'codex-bridge', 'agent.md');
    await fs.writeFile(source, 'host file');
    const writer = createHomeWriter({ root: home, imageMembers: [] });

    await copyPlannedFile(planned(source, target), home, { writer });

    assert.equal(await fs.readFile(target, 'utf8'), 'host file');
  });
});

test('the raw route refuses a target inside the package home', async () => {
  await withTempTree('copy-raw-home-', async (root) => {
    const home = path.join(root, 'home');
    const source = path.join(root, 'source.json');
    const target = path.join(home, 'config.json');
    await fs.writeFile(source, '{}');
    const writer = createHomeWriter({ root: home, imageMembers: [] });

    await assert.rejects(
      copyPlannedFile(planned(source, target), home, { writer }),
      (error) => error.code === 'EHOMEREGISTRY',
    );
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  });
});

test('a missing writer throws a plain Error', async () => {
  await withTempTree('copy-no-writer-', async (root) => {
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'source');

    await assert.rejects(
      copyPlannedFile(planned(source, path.join(root, 'target.txt')), root),
      (error) => error.constructor === Error,
    );
  });
});
