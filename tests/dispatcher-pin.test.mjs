/** Guards the installed, unanimous, read-only dispatcher contract in Plan_67 D10. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { claudePaths } from '../src/home/lib/claude-layout.mjs';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';
import { readDispatcherPin } from '../src/home/lib/dispatcher-pin.mjs';
import { homeArtifact } from '../src/home/lib/home-registry.mjs';
import { readOwnerRoots } from '../src/home/lib/install-owner-roots.mjs';
import { withTempTree } from './temp-tree.mjs';

const agentType = 'sample-dispatcher';
const recordPath = (brandRoot) => path.join(brandRoot, homeArtifact('install-record').primary[0]);

async function withPinFixture(specs, work) {
  await withTempTree('dispatcher-pin-', async (tree) => {
    const brandRoot = path.join(tree, 'brand home');
    fs.mkdirSync(brandRoot);
    const owners = {};
    const files = [];
    const roots = specs.map((spec, index) => {
      const scope = spec.project ? 'project scope' : 'user scope';
      const root = path.join(tree, scope, String(index), '.claude');
      owners[`owner-${index}`] = { root };
      const file = path.join(claudePaths(root).agentsDir, `${agentType}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (spec.unreadable) fs.mkdirSync(file);
      else if (!spec.missing) {
        const content = spec.content ?? `---\nname: ${spec.name ?? agentType}\nmodel: ${spec.model}\n---\nBody.\n`;
        fs.writeFileSync(file, content);
        files.push({ file, content });
      }
      return root;
    });
    const record = JSON.stringify({ format: 2, inventory: 'complete', owners });
    fs.writeFileSync(recordPath(brandRoot), record);
    await work({ brandRoot, roots });
    assert.equal(fs.readFileSync(recordPath(brandRoot), 'utf8'), record, 'the record remains unchanged');
    for (const { file, content } of files) {
      assert.equal(fs.readFileSync(file, 'utf8'), content, 'installed definitions remain unchanged');
    }
  });
}

function expectReasons(result, count) {
  assert.deepEqual(Object.keys(result).sort(), ['family', 'reasons']);
  assert.equal(result.family, null);
  assert.equal(result.reasons.length, count);
  for (const reason of result.reasons) assert.match(reason, /^[^\r\n]+\.$/);
}

test('shared layout preserves all five package paths used by the installer', () => {
  const root = path.join('a', '.claude');
  assert.deepEqual(claudePaths(root), {
    agentsDir: path.join(root, 'agents', 'codex-bridge'),
    commandsDir: path.join(root, 'commands', 'codex-bridge'),
    rulesDir: path.join(root, 'rules', 'codex-bridge'),
    legacyAgentsDir: path.join(root, 'agents', 'codex'),
    legacyCommandsDir: path.join(root, 'commands', 'codex'),
  });
});

test('one owner yields the family from its installed definition without writing', async () => {
  await withPinFixture([{ model: 'sonnet[1m]' }], ({ brandRoot, roots }) => {
    assert.deepEqual(readDispatcherPin({ brandRoot, agentType }), { family: 'sonnet', roots });
  });
});

test('two owners including a project root agree by family across different id shapes', async () => {
  await withPinFixture([
    { model: 'claude-haiku-4-5-20251001' },
    { project: true, model: 'claude-3-5-haiku-20241022' },
  ], ({ brandRoot, roots }) => {
    assert.deepEqual(readDispatcherPin({ brandRoot, agentType }), { family: 'haiku', roots: roots.sort() });
  });
});

test('disagreeing owners yield one reason listing every root and family', async () => {
  await withPinFixture([{ model: 'haiku' }, { project: true, model: 'sonnet' }], ({ brandRoot, roots }) => {
    const result = readDispatcherPin({ brandRoot, agentType });
    expectReasons(result, 1);
    assert.ok(result.reasons[0].includes(`"${roots[0]}" -> haiku`));
    assert.ok(result.reasons[0].includes(`"${roots[1]}" -> sonnet`));
  });
});

test('missing and unreadable definitions name the exact file and installation repair command', async () => {
  for (const problem of ['missing', 'unreadable']) {
    await withPinFixture([{ [problem]: true }], ({ brandRoot, roots }) => {
      const result = readDispatcherPin({ brandRoot, agentType });
      expectReasons(result, 1);
      const file = path.join(claudePaths(roots[0]).agentsDir, `${agentType}.md`);
      assert.ok(result.reasons[0].includes(file));
      assert.ok(result.reasons[0].includes(`${CLI_NAMES[0]} install --host "${roots[0]}"`));
      assert.ok(result.reasons[0].includes(problem === 'missing' ? 'is missing' : 'cannot be read'));
      assert.equal(fs.existsSync(file), problem !== 'missing', 'reading does not repair files');
    });
  }
});

test('wrong or absent frontmatter name cannot supply a pin', async () => {
  for (const spec of [{ name: 'another-dispatcher', model: 'haiku' }, { content: '---\nmodel: haiku\n---\n' }]) {
    await withPinFixture([spec], ({ brandRoot, roots }) => {
      const result = readDispatcherPin({ brandRoot, agentType });
      expectReasons(result, 1);
      assert.ok(result.reasons[0].includes(path.join(claudePaths(roots[0]).agentsDir, `${agentType}.md`)));
      assert.ok(result.reasons[0].includes('frontmatter name'));
      assert.ok(result.reasons[0].includes(agentType));
    });
  }
});

test('inherit, other non-family models and an absent model make the pin undetermined', async () => {
  for (const spec of [
    { model: 'inherit' }, { model: 'default' }, { model: 'opusplan' },
    { model: 'proxy2' }, { model: '"<synthetic>"' }, { content: `---\nname: ${agentType}\n---\n` },
  ]) {
    await withPinFixture([spec], ({ brandRoot, roots }) => {
      const result = readDispatcherPin({ brandRoot, agentType });
      expectReasons(result, 1);
      assert.ok(result.reasons[0].includes('no parseable model family'));
      assert.ok(result.reasons[0].includes(path.join(claudePaths(roots[0]).agentsDir, `${agentType}.md`)));
    });
  }
});

test('absent, duplicate-key and malformed frontmatter are unreadable reasons', async () => {
  for (const content of [
    'No frontmatter.\n',
    `---\nname: ${agentType}\nmodel: haiku\nmodel: sonnet\n---\n`,
    `---\nname: ${agentType}\nmodel: haiku\n`,
    `---\nname: ${agentType}\nmodel: "unterminated\n---\n`,
  ]) {
    await withPinFixture([{ content }], ({ brandRoot, roots }) => {
      const result = readDispatcherPin({ brandRoot, agentType });
      expectReasons(result, 1);
      assert.match(result.reasons[0], /frontmatter.*unreadable/);
      assert.ok(result.reasons[0].includes(path.join(claudePaths(roots[0]).agentsDir, `${agentType}.md`)));
    });
  }
});

test('one broken owner prevents a pin and every broken owner is reported', async () => {
  await withPinFixture([
    { model: 'haiku' }, { project: true, missing: true }, { model: 'inherit' },
  ], ({ brandRoot, roots }) => {
    const result = readDispatcherPin({ brandRoot, agentType });
    expectReasons(result, 2);
    for (const root of roots.slice(1)) assert.ok(result.reasons.some((reason) => reason.includes(root)));
  });
});

test('installation record problems pass through as one reason without changing the record', async () => {
  for (const raw of [undefined, '{invalid', JSON.stringify({ format: 1 }), JSON.stringify({
    format: 2, inventory: 'incomplete', owners: {},
  }), JSON.stringify({ format: 2, inventory: 'complete', owners: {} })]) {
    await withTempTree('dispatcher-pin-record-', async (brandRoot) => {
      const file = recordPath(brandRoot);
      if (raw !== undefined) fs.writeFileSync(file, raw);
      const ownerResult = readOwnerRoots({ brandRoot });
      assert.deepEqual(readDispatcherPin({ brandRoot, agentType }), { family: null, reasons: [ownerResult.detail] });
      if (raw === undefined) assert.deepEqual(fs.readdirSync(brandRoot), []);
      else assert.equal(fs.readFileSync(file, 'utf8'), raw);
    });
  }
});
