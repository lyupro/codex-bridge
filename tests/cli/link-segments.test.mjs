/** Verifies shared deletion-path inspection stops top-down at the first unsafe segment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectSegments } from '../../cli/link-segments.mjs';
import { makeTempTree } from '../temp-tree.mjs';

function makeRoot() {
  const tree = makeTempTree('link-segments-');
  const root = path.join(tree, 'runs');
  fs.mkdirSync(root);
  return { tree, root };
}

test('accepts a junction at the trusted root', () => {
  const tree = makeTempTree('link-segments-');
  const root = path.join(tree, 'runs');
  const realRoot = path.join(tree, 'real-runs');
  const file = path.join(realRoot, 'alpha', 'run.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'run');
  fs.symlinkSync(realRoot, root, 'junction');

  assert.deepEqual(inspectSegments(path.join(root, 'alpha', 'run.txt'), root), { kind: 'clear' });
});

test('reports the first ancestor junction and never inspects beneath it', () => {
  const { tree, root } = makeRoot();
  const ancestor = path.join(root, 'alpha', 'linked');
  const outside = path.join(tree, 'outside');
  fs.mkdirSync(path.join(root, 'alpha'));
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, ancestor, 'junction');
  const checked = [];
  const target = path.join(ancestor, 'nested', 'run');

  const result = inspectSegments(target, root, {
    lstat(file) {
      checked.push(file);
      return fs.lstatSync(file);
    },
  });

  assert.deepEqual(result, { kind: 'link', at: ancestor });
  assert.deepEqual(checked, [path.join(root, 'alpha'), ancestor]);
});

test('reports a junction at the target', () => {
  const { tree, root } = makeRoot();
  const target = path.join(root, 'linked');
  fs.mkdirSync(path.join(tree, 'outside'));
  fs.symlinkSync(path.join(tree, 'outside'), target, 'junction');

  assert.deepEqual(inspectSegments(target, root), { kind: 'link', at: target });
});

test('reports a dangling junction without following it', () => {
  const { tree, root } = makeRoot();
  const target = path.join(root, 'dangling');
  fs.symlinkSync(path.join(tree, 'does-not-exist'), target, 'junction');

  assert.deepEqual(inspectSegments(target, root), { kind: 'link', at: target });
});

test('reports the first missing ancestor', () => {
  const { root } = makeRoot();
  const missing = path.join(root, 'missing');

  assert.deepEqual(inspectSegments(path.join(missing, 'run'), root), { kind: 'missing', at: missing });
});

test('rejects the root itself and targets outside it', () => {
  const { tree, root } = makeRoot();

  assert.deepEqual(inspectSegments(root, root), { kind: 'outside' });
  assert.deepEqual(inspectSegments(path.join(tree, 'outside'), root), { kind: 'outside' });
});

test('fails closed on non-ENOENT lstat errors', () => {
  const { root } = makeRoot();
  const ancestor = path.join(root, 'alpha');
  fs.mkdirSync(ancestor);
  const checked = [];

  const result = inspectSegments(path.join(ancestor, 'run'), root, {
    lstat(file) {
      checked.push(file);
      if (file === ancestor) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.lstatSync(file);
    },
  });

  assert.deepEqual(result, { kind: 'error', at: ancestor, code: 'EACCES' });
  assert.deepEqual(checked, [ancestor]);
});