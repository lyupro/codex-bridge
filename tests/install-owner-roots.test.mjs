/** Verifies the read-only owner boundary required by hooks in Plan_67 D10. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withOwner } from '../cli/install-owners.mjs';
import { homeArtifact } from '../src/home/lib/home-registry.mjs';
import { isFormat2, readOwnerRoots } from '../src/home/lib/install-owner-roots.mjs';
import { withTempTree } from './temp-tree.mjs';

const recordPath = (brandRoot) => path.join(brandRoot, homeArtifact('install-record').primary[0]);
const complete = () => ({ format: 2, inventory: 'complete', owners: { alpha: { root: '/repos/alpha/.claude' } } });

async function expectProblem(parsed, problem) {
  await withTempTree('owner-roots-', async (brandRoot) => {
    const file = recordPath(brandRoot);
    const raw = JSON.stringify(parsed);
    fs.writeFileSync(file, raw);
    const result = readOwnerRoots({ brandRoot });
    assert.deepEqual(Object.keys(result).sort(), ['detail', 'problem']);
    assert.equal(result.problem, problem);
    assert.ok(result.detail.includes(file));
    assert.match(result.detail, /^[^\r\n]+\.$/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'reading must leave the record unchanged');
  });
}

test('isFormat2 retains its object and exact numeric format contract', () => {
  assert.equal(isFormat2({ format: 2 }), true);
  for (const parsed of [null, false, 2, '2', [], { format: '2' }, { format: 1 }, { format: 3 }, {}]) {
    assert.equal(isFormat2(parsed), false);
  }
  assert.equal(isFormat2(Object.assign([], { format: 2 })), false);
});

test('missing record is reported without creating it', async () => {
  await withTempTree('owner-roots-', async (brandRoot) => {
    const file = recordPath(brandRoot);
    assert.deepEqual(readOwnerRoots({ brandRoot }), {
      problem: 'missing', detail: `Installation record at ${file} is missing.`,
    });
    assert.deepEqual(fs.readdirSync(brandRoot), []);
  });
});

test('other read errors are unreadable', async () => {
  await withTempTree('owner-roots-', async (brandRoot) => {
    const file = recordPath(brandRoot);
    fs.mkdirSync(file);
    assert.deepEqual(readOwnerRoots({ brandRoot }), {
      problem: 'unreadable', detail: `Installation record at ${file} cannot be read.`,
    });
    assert.ok(fs.statSync(file).isDirectory());
  });
});

test('invalid JSON is unreadable and is never rewritten', async () => {
  await withTempTree('owner-roots-', async (brandRoot) => {
    const file = recordPath(brandRoot);
    fs.writeFileSync(file, '{invalid');
    assert.deepEqual(readOwnerRoots({ brandRoot }), {
      problem: 'unreadable', detail: `Installation record at ${file} contains invalid JSON.`,
    });
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  });
});

test('non-format-2 records fail before inventory is considered', async () => {
  for (const parsed of [null, [], 2, {}, { format: 1 }, { format: '2' }, { format: 3 }]) {
    await expectProblem(parsed, 'not-format-2');
  }
});

test('inventory must be explicitly complete before legacy is considered when owners exist', async () => {
  for (const inventory of [undefined, null, 'incomplete', 'unknown']) {
    await expectProblem({ ...complete(), inventory, legacy: {} }, 'inventory-incomplete');
  }
});

test('a present legacy partition is rejected even when null', async () => {
  for (const legacy of [{}, null, false]) {
    await expectProblem({ ...complete(), legacy }, 'legacy-partition');
  }
});

test('owners must be a non-empty object', async () => {
  for (const owners of [undefined, null, [], '', 123, {}]) {
    for (const inventory of ['complete', 'incomplete', undefined]) {
      await expectProblem({ format: 2, inventory, owners }, 'no-owners');
    }
  }
});

test('each owner must carry a non-empty string root', async () => {
  for (const owner of [null, {}, { root: null }, { root: 123 }, { root: '' }, { root: '   ' }]) {
    await expectProblem({ ...complete(), owners: { ...complete().owners, broken: owner } }, 'malformed-owner');
  }
});

test('every owner root is returned sorted with its recorded spelling intact', async () => {
  await withTempTree('owner-roots-', async (brandRoot) => {
    const file = recordPath(brandRoot);
    const roots = ['Z:/Repos/Beta/../Beta/.claude', ' C:/Repos/Alpha/.claude '];
    const parsed = { ...complete(), owners: { z: { root: roots[0] }, a: { root: roots[1] } } };
    const raw = JSON.stringify(parsed);
    fs.writeFileSync(file, raw);
    assert.deepEqual(readOwnerRoots({ brandRoot }), { roots: [...roots].sort() });
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(brandRoot), [path.basename(file)]);
  });
});

test('the reader keeps roots for every owner rather than deduplicating them', async () => {
  await withTempTree('owner-roots-', async (brandRoot) => {
    const root = '/repos/shared/.claude';
    fs.writeFileSync(recordPath(brandRoot), JSON.stringify({
      ...complete(), owners: { a: { root }, b: { root } },
    }));
    assert.deepEqual(readOwnerRoots({ brandRoot }), { roots: [root, root] });
  });
});

test('BOM-prefixed records use the shared JSON boundary', async () => {
  await withTempTree('owner-roots-', async (brandRoot) => {
    fs.writeFileSync(recordPath(brandRoot), '\ufeff' + JSON.stringify(complete()));
    assert.deepEqual(readOwnerRoots({ brandRoot }), { roots: ['/repos/alpha/.claude'] });
  });
});

test('withOwner records read back only when the inventory is explicitly complete', async () => {
  await withTempTree('owner-roots-', async (brandRoot) => {
    const host = { root: path.join(brandRoot, 'host', '.claude'), scope: 'project' };
    const ownerPath = 'agents/alpha/reply-guard.mjs';
    const record1 = {
      name: '@lyupro/codex-bridge',
      version: '1.2.3',
      installedAt: '2026-09-27T17:00:00.000Z',
      mode: 'copy',
      files: [{ root: 'claude', path: ownerPath }, { root: 'brand', path: 'lib/runner.mjs' }],
      fingerprints: {
        claude: { [ownerPath]: 'a'.repeat(64) },
        brand: { 'lib/runner.mjs': 'b'.repeat(64) },
      },
      hooks: [{ event: 'SubagentStop', root: 'claude', path: ownerPath, command: 'codex-bridge hook reply-guard' }],
    };
    const file = recordPath(brandRoot);
    fs.writeFileSync(file, JSON.stringify(withOwner(null, host, record1, { inventory: 'complete' })));
    assert.deepEqual(readOwnerRoots({ brandRoot }), { roots: [host.root] });
    fs.writeFileSync(file, JSON.stringify(withOwner(null, host, record1)));
    assert.deepEqual(readOwnerRoots({ brandRoot }), {
      problem: 'inventory-incomplete', detail: `Installation record at ${file} has an incomplete inventory; if the recorded hosts are all the hosts using this home, run codex-bridge inventory confirm.`,
    });
  });
});
