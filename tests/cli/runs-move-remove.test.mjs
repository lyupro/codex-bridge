/** Plan_77 D3/B5c: old-version writers must not lose records after the root switch. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectRunStore, sha256File } from '../../cli/runs-move-copy.mjs';
import { oldStoreDifferences, removeOldStore } from '../../cli/runs-move-remove.mjs';
import { withTempTree } from '../temp-tree.mjs';

function fixture(root, oldName = 'old') {
  const from = path.join(root, oldName);
  const to = path.join(root, 'new');
  for (const store of [from, to]) {
    fs.mkdirSync(path.join(store, 'project', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(store, 'project', 'events.jsonl'), Buffer.from([0, 10, 255]));
    fs.writeFileSync(path.join(store, 'reply.txt'), 'reply');
  }
  return { from, to };
}

function snapshot(root) {
  return [...inspectRunStore(root).entries].map(([relative, entry]) =>
    [relative, entry.directory ? 'directory' : sha256File(path.join(root, relative))]);
}

const yes = { interactive: () => true, ask: async () => 'yes' };

test('identical stores are removable after yes; the new store remains byte-for-byte unchanged', async () => {
  await withTempTree('runs-remove-identical-', async (root) => {
    const stores = fixture(root);
    const before = snapshot(stores.to);
    const questionOptions = { isTTY: true, prompt: (question) => {
      assert.equal(question, `Remove the old folder ${stores.from}? Every file in it has an identical copy in ${stores.to}. `
        + 'It stays in the history of the git repository that holds it until that project commits the removal.');
      return 'yes';
    } };
    assert.deepEqual(oldStoreDifferences(stores), { paths: [], count: 0 });
    assert.deepEqual(await removeOldStore({ ...stores, questionOptions }),
      { exitCode: 0, output: `Removed ${stores.from}.` });
    assert.equal(fs.existsSync(stores.from), false);
    assert.deepEqual(snapshot(stores.to), before);
  });
});

const changedPath = path.join('project', 'events.jsonl');
for (const [name, mutate, expected] of [
  ['run added after the copy', ({ from }) => fs.writeFileSync(path.join(from, 'late-run'), 'new'), ['late-run']],
  ['changed byte of the same size', ({ from }) => fs.writeFileSync(path.join(from, changedPath), Buffer.from([0, 11, 255])), [changedPath]],
  ['changed size', ({ from }) => fs.appendFileSync(path.join(from, 'reply.txt'), ' more'), ['reply.txt']],
  ['missing destination file', ({ to }) => fs.unlinkSync(path.join(to, 'reply.txt')), ['reply.txt']],
  ['directory replaced by a file', ({ to }) => {
    fs.rmdirSync(path.join(to, 'project', 'empty'));
    fs.writeFileSync(path.join(to, 'project', 'empty'), 'file');
  }, [path.join('project', 'empty')]],
  ['file replaced by a directory', ({ to }) => {
    fs.unlinkSync(path.join(to, 'reply.txt'));
    fs.mkdirSync(path.join(to, 'reply.txt'));
  }, ['reply.txt']],
  ['missing empty directory', ({ to }) => fs.rmdirSync(path.join(to, 'project', 'empty')), [path.join('project', 'empty')]],
]) {
  test(`${name} is listed and blocks removal before asking or checking the terminal`, async () => {
    await withTempTree('runs-remove-diff-', async (root) => {
      const stores = fixture(root);
      mutate(stores);
      const oldBefore = snapshot(stores.from);
      const newBefore = snapshot(stores.to);
      assert.deepEqual(oldStoreDifferences(stores), { paths: expected, count: expected.length });
      assert.deepEqual(await removeOldStore({ ...stores,
        interactive: () => assert.fail('differences must be checked first'),
        ask: () => assert.fail('differences must block the question'),
      }), { exitCode: 1,
        output: `The old folder ${stores.from} has ${expected.length} entries the new store does not hold identically:\n${expected.join('\n')}\nNothing was removed.` });
      assert.deepEqual(snapshot(stores.from), oldBefore);
      assert.deepEqual(snapshot(stores.to), newBefore);
    });
  });
}

test('new runs and imported git metadata only in the destination do not block removal', async () => {
  await withTempTree('runs-remove-extra-', async (root) => {
    const stores = fixture(root);
    fs.mkdirSync(path.join(stores.to, 'new-project'));
    fs.writeFileSync(path.join(stores.to, 'new-project', 'reply.txt'), 'new run');
    fs.mkdirSync(path.join(stores.to, '.git'));
    fs.writeFileSync(path.join(stores.to, '.git', 'HEAD'), 'history');
    const before = snapshot(stores.to);
    assert.deepEqual(await removeOldStore({ ...stores, ...yes }),
      { exitCode: 0, output: `Removed ${stores.from}.` });
    assert.equal(fs.existsSync(stores.from), false);
    assert.deepEqual(snapshot(stores.to), before);
  });
});

test('non-interactive stdin keeps the old store and prints the terminal hint without asking', async () => {
  await withTempTree('runs-remove-terminal-', async (root) => {
    const stores = fixture(root);
    const before = snapshot(stores.from);
    const result = await removeOldStore({ ...stores, questionOptions: { stdin: { isTTY: false } },
      ask: () => assert.fail('non-interactive stdin must not ask') });
    assert.deepEqual(result, { exitCode: 0,
      output: `The old folder ${stores.from} is still there; run codex-bridge runs move in a terminal to remove it.` });
    assert.deepEqual(snapshot(stores.from), before);
  });
});

for (const [answer, exitCode, output] of [
  ['no', 0, 'The old folder was kept.'],
  ['cancel', 130, 'Cancelled; nothing was removed.'],
  ['', 0, 'The old folder was kept.'],
]) {
  test(`${answer || 'no answer'} keeps the old folder with exit ${exitCode}`, async () => {
    await withTempTree('runs-remove-answer-', async (root) => {
      const stores = fixture(root);
      const oldBefore = snapshot(stores.from);
      const newBefore = snapshot(stores.to);
      assert.deepEqual(await removeOldStore({ ...stores,
        questionOptions: { isTTY: true, prompt: () => answer } }), { exitCode, output });
      assert.deepEqual(snapshot(stores.from), oldBefore);
      assert.deepEqual(snapshot(stores.to), newBefore);
    });
  });
}

test('differences retain the full count but list at most 20 relative paths', async () => {
  await withTempTree('runs-remove-limit-', async (root) => {
    const stores = fixture(root);
    const missing = Array.from({ length: 25 }, (_, index) => `late-${String(index).padStart(2, '0')}`);
    for (const name of missing) fs.writeFileSync(path.join(stores.from, name), 'late');
    assert.deepEqual(oldStoreDifferences(stores), { paths: missing.slice(0, 20), count: 25 });
    const result = await removeOldStore({ ...stores, ...yes });
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes('has 25 entries'));
    assert.ok(result.output.includes('late-19'));
    assert.ok(!result.output.includes('late-20'));
    assert.equal(fs.existsSync(stores.from), true);
  });
});

// D3/B5c: checking only before the prompt would destroy a run written while the operator answers.
for (const [name, mutate, expected] of [
  ['added run', ({ from }) => fs.writeFileSync(path.join(from, 'late-run'), 'late'), 'late-run'],
  ['changed byte', ({ from }) => fs.writeFileSync(path.join(from, 'reply.txt'), 'Reply'), 'reply.txt'],
  ['lost copy', ({ to }) => fs.unlinkSync(path.join(to, 'reply.txt')), 'reply.txt'],
]) {
  test(`${name} during confirmation is rechecked and prevents removal`, async () => {
    await withTempTree('runs-remove-prompt-write-', async (root) => {
      const stores = fixture(root);
      const result = await removeOldStore({ ...stores, interactive: () => true, ask: async () => {
        mutate(stores);
        return 'yes';
      } });
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes(expected));
      assert.match(result.output, /Nothing was removed\.$/);
      assert.equal(fs.existsSync(stores.from), true);
    });
  });
}

test('hash failures keep the old store and fail loudly', async () => {
  await withTempTree('runs-remove-hash-', async (root) => {
    const stores = fixture(root);
    const before = snapshot(stores.from);
    assert.deepEqual(await removeOldStore({ ...stores, ...yes,
      hash: () => { throw new Error('Cannot hash the record'); } }),
    { exitCode: 1, output: 'Cannot hash the record\nNothing was removed.' });
    assert.deepEqual(snapshot(stores.from), before);
  });
});

test('overlapping stores are never removable even when their contents appear identical', async () => {
  await withTempTree('runs-remove-overlap-', async (root) => {
    const stores = fixture(root);
    for (const to of [stores.from, path.join(stores.from, 'project'), root]) {
      const before = snapshot(stores.from);
      const result = await removeOldStore({ from: stores.from, to, ...yes });
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /Run store paths overlap/);
      assert.deepEqual(snapshot(stores.from), before);
    }
  });
});

if (process.platform === 'win32') {
  test('Windows removes an old folder whose name ends in a dot with ordinary Node fs paths', async () => {
    await withTempTree('runs-remove-dot-', async (root) => {
      const stores = fixture(root, 'old.');
      assert.ok(fs.readdirSync(root).includes('old.'));
      const before = snapshot(stores.to);
      assert.deepEqual(await removeOldStore({ ...stores, ...yes }),
        { exitCode: 0, output: `Removed ${stores.from}.` });
      assert.equal(fs.existsSync(stores.from), false);
      assert.deepEqual(fs.readdirSync(root), ['new']);
      assert.deepEqual(snapshot(stores.to), before);
    });
  });
}
