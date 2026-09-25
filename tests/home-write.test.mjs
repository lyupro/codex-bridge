/** Verifies the Plan_62 D22 artifact-id boundary before any home filesystem write occurs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { makeTempTree } from './temp-tree.mjs';

function isRegistryError(error, id, absolutePath) {
  return error.code === 'EHOMEREGISTRY'
    && error.message.includes(id)
    && error.message.includes(absolutePath);
}

function dotTemporary(absolutePath) {
  return path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
}

test('declared sync and promise writers preserve node:fs results and contents', async () => {
  const tree = makeTempTree('home-write-allowed-');
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root });
  const nativeMkdirResult = fs.mkdirSync(path.join(tree, 'native-root'), { recursive: true });
  const mkdirResult = writer.mkdirSync('config', root);
  assert.equal(typeof mkdirResult, typeof nativeMkdirResult);

  const configPath = path.join(root, 'config.json');
  const nativeWriteResult = fs.writeFileSync(path.join(tree, 'native.txt'), 'sync');
  assert.equal(writer.writeFileSync('config', configPath, 'sync'), nativeWriteResult);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'sync');

  const asyncWriteResult = await writer.writeFile('config', configPath, 'async');
  assert.equal(asyncWriteResult, await fs.promises.writeFile(path.join(tree, 'native-async.txt'), 'async'));
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'async');

  const descriptor = writer.openSync('config', configPath, 'r');
  assert.equal(typeof descriptor, 'number');
  assert.equal(fs.readFileSync(descriptor, 'utf8'), 'async');
  fs.closeSync(descriptor);
  const handle = await writer.open('config', configPath, 'r');
  assert.equal(await handle.readFile('utf8'), 'async');
  await handle.close();

  const temporaryPath = dotTemporary(configPath);
  assert.equal(writer.renameSync('config', configPath, temporaryPath), undefined);
  assert.equal(fs.readFileSync(temporaryPath, 'utf8'), 'async');
  assert.equal(writer.renameSync('config', temporaryPath, configPath), undefined);
  const lockPath = `${configPath}.lock`;
  assert.equal(await writer.rename('config', configPath, lockPath), undefined);
  assert.equal(await writer.rename('config', lockPath, configPath), undefined);

  assert.equal(writer.unlinkSync('config', configPath), undefined);
  assert.equal(fs.existsSync(configPath), false);
  await writer.writeFile('config', configPath, 'remove asynchronously');
  assert.equal(await writer.unlink('config', configPath), undefined);
  assert.equal(fs.existsSync(configPath), false);

  const nativeAsyncMkdirResult = await fs.promises.mkdir(path.join(tree, 'native-async-dir'), { recursive: true });
  const diagnosticsDir = path.join(root, 'state', 'diagnostics');
  const asyncMkdirResult = await writer.mkdir('diagnostics', diagnosticsDir);
  assert.equal(typeof asyncMkdirResult, typeof nativeAsyncMkdirResult);
  assert.equal(writer.rmdirSync('diagnostics', diagnosticsDir), undefined);
  assert.equal(fs.existsSync(diagnosticsDir), false);
});

test('wrong ids, undeclared names and paths outside the home fail before creating files', () => {
  const tree = makeTempTree('home-write-refused-');
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root });
  const attempts = [
    ['conventions', path.join(root, 'config.json')],
    ['config', path.join(root, 'undeclared.json')],
    ['config', path.join(tree, 'outside.json')],
    ['config', path.join(root, '..', 'escaped.json')],
  ];

  for (const [id, absolutePath] of attempts) {
    assert.throws(
      () => writer.writeFileSync(id, absolutePath, 'must not be written'),
      (error) => isRegistryError(error, id, absolutePath),
    );
    assert.equal(fs.existsSync(absolutePath), false, absolutePath);
  }
});

test('rename across artifact ids and mkdir outside declared directories are refused', () => {
  const tree = makeTempTree('home-write-directory-');
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root });
  const configPath = path.join(root, 'config.json');
  const conventionsPath = path.join(root, 'conventions.md');

  assert.throws(
    () => writer.renameSync('config', configPath, conventionsPath),
    (error) => isRegistryError(error, 'config', conventionsPath),
  );
  assert.equal(fs.existsSync(conventionsPath), false);

  const undeclaredDirectory = path.join(root, 'unregistered', 'nested');
  assert.throws(
    () => writer.mkdirSync('config', undeclaredDirectory),
    (error) => isRegistryError(error, 'config', undeclaredDirectory),
  );
  assert.equal(fs.existsSync(root), false);

  const wrongArtifactDirectory = path.join(root, 'state', 'dispatchers');
  assert.throws(
    () => writer.mkdirSync('config', wrongArtifactDirectory),
    (error) => isRegistryError(error, 'config', wrongArtifactDirectory),
  );
  assert.equal(fs.existsSync(root), false);
});

test('copyFile accepts external sources only for caller-declared image members', async () => {
  const tree = makeTempTree('home-write-copy-');
  const root = path.join(tree, 'home');
  const source = path.join(tree, 'package-image.mjs');
  fs.writeFileSync(source, 'package image');

  const undeclaredPath = path.join(root, 'image', 'hooks', 'undeclared.mjs');
  const undeclaredWriter = createHomeWriter({ root });
  assert.throws(
    () => undeclaredWriter.copyFile('install-image', source, undeclaredPath),
    (error) => isRegistryError(error, 'install-image', undeclaredPath),
  );
  assert.equal(fs.existsSync(root), false);

  const member = 'image/hooks/guard.mjs';
  const destination = path.join(root, ...member.split('/'));
  const writer = createHomeWriter({ root, imageMembers: [member] });
  const mkdirResult = writer.mkdirSync('install-image', path.dirname(destination));
  assert.equal(typeof mkdirResult, 'string');
  assert.equal(await writer.copyFile('install-image', source, destination), undefined);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'package image');
});
