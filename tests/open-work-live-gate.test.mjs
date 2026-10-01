/** Guards Plan_72 R3 B2: the open-work CLI cannot bypass the index or live-threshold rule. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withTempTree } from './temp-tree.mjs';
import { validateOpenWork } from '../scripts/open-work/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = new Map([
  'scripts/open-work/register.mjs', 'scripts/open-work/check.mjs', 'scripts/open-work/live-thresholds.mjs',
  'cli/invoked-directly.mjs',
].map((relative) => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]));
const indexPath = 'docs/checklists/operator-checklists.md';
const checklistPath = 'docs/checklists/Checklist.md';

function register(home = 'docs/plans/Plan.md', owner = 'агент') {
  return `## Пункты
### OW-001 — A task
- состояние: open
- владелец: ${owner}
- источник: A handoff
- дом: ${home}
- следующий шаг: Run the next step
`;
}

function index(groups) {
  return `## Актуальные\n- [Checklist](Checklist.md) live=${JSON.stringify(groups)}\n`;
}

async function fixture(options, work) {
  return withTempTree('open-work-live-gate-', async (directory) => {
    for (const folder of options.folders ?? ['docs/plans', 'docs/checklists']) {
      fs.mkdirSync(path.join(directory, folder), { recursive: true });
    }
    const files = { ...(options.files ?? { 'docs/plans/Plan.md': '# Plan\nSee OW-001.\n' }) };
    if (options.register !== null) files['docs/plans/open-work.md'] = options.register ?? register();
    if (options.index !== null) files[indexPath] = options.index ?? index([]);
    if (options.package !== null) files['package.json'] = options.package ?? '{"version":"1.0.0"}\n';
    for (const [relative, source] of sources) files[relative] = source;
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, 'utf8');
    }
    return work(directory);
  });
}

function run(directory, strict = false) {
  const result = spawnSync(process.execPath, [
    path.join(directory, 'scripts/open-work/check.mjs'), ...(strict ? ['--strict'] : []),
  ], { cwd: path.join(directory, 'scripts'), encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return result;
}

test('missing index fails in ordinary and strict mode when both workroom folders exist', async () => {
  await fixture({ index: null }, (directory) => {
    for (const strict of [false, true]) {
      const result = run(directory, strict);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.trim(), `${indexPath}:1: checklist index is missing`);
    }
    assert.deepEqual(validateOpenWork(directory), {
      violations: [`${indexPath}:1: checklist index is missing`], notices: [], message: null,
    });
  });
});

test('missing index fails when only the checklist folder exists', async () => {
  await fixture({ folders: ['docs/checklists'], register: null, index: null, files: {} }, (directory) => {
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), 'docs/plans/open-work.md:1: register is missing\n'
      + `${indexPath}:1: checklist index is missing`);
  });
});

test('both folders absent still skips ordinary validation with an empty notices array', async () => {
  await fixture({ folders: [], register: null, index: null, package: null, files: {} }, (directory) => {
    const result = run(directory);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'Workroom is absent; nothing was checked.');
    assert.deepEqual(validateOpenWork(directory), {
      violations: [], notices: [], message: 'Workroom is absent; nothing was checked.',
    });
  });
});

test('active checklist without a live marker fails in both modes', async () => {
  await fixture({ index: '## Актуальные\n- [Checklist](Checklist.md)\n' }, (directory) => {
    for (const strict of [false, true]) {
      const result = run(directory, strict);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.trim(), `${indexPath}:2: active checklist line must end with exactly one live= array marker`);
    }
  });
});

test('overdue live group without work fails the CLI', async () => {
  await fixture({ index: index([{ steps: ['4'], threshold: '0.9.0' }]) }, (directory) => {
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), `${indexPath}:2: overdue: ${checklistPath} steps 4 waited for 0.9.0, the package is 1.0.0`);
  });
});

test('an exact open-work home binding holds an overdue live group and prints a notice', async () => {
  await fixture({
    index: index([{ steps: ['4'], threshold: '0.9.0', work: 'OW-001' }]),
    register: register(`${checklistPath} steps 4`), files: { [checklistPath]: '# Checklist\nOW-001\n' },
  }, (directory) => {
    for (const strict of [false, true]) {
      const result = run(directory, strict);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.stdout.trim(), `note: ${indexPath}:2: overdue, held by OW-001: ${checklistPath} steps 4 waited for 0.9.0`);
    }
  });
});

test('due live group passes and prints its notice separately from violations', async () => {
  await fixture({ index: index([{ steps: ['4'], threshold: '1.0.0' }]) }, (directory) => {
    const result = run(directory);
    const notice = `${indexPath}:2: due: ${checklistPath} steps 4 wait for 1.0.0, the package is 1.0.0`;
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `note: ${notice}`);
    assert.deepEqual(validateOpenWork(directory), { violations: [], notices: [notice], message: null });
  });
});

test('CLI prints notices after unrelated register violations even on failure', async () => {
  await fixture({
    register: register('docs/plans/Plan.md', 'robot'), index: index([{ steps: ['4'], threshold: '1.0.0' }]),
  }, (directory) => {
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
      'docs/plans/open-work.md:4: OW-001: invalid владелец robot',
      `note: ${indexPath}:2: due: ${checklistPath} steps 4 wait for 1.0.0, the package is 1.0.0`,
    ]);
  });
});

test('missing register does not bypass index validation or suppress notices', async () => {
  await fixture({ register: null, index: index([{ steps: ['4'], threshold: '1.0.0' }]) }, (directory) => {
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
      'docs/plans/open-work.md:1: register is missing',
      `note: ${indexPath}:2: due: ${checklistPath} steps 4 wait for 1.0.0, the package is 1.0.0`,
    ]);
  });
});

for (const [name, contents] of [['missing', null], ['non-JSON', '{'], ['missing version', '{}']]) {
  test(`${name} package.json produces exactly one stdout violation at package.json:1`, async () => {
    await fixture({ package: contents }, (directory) => {
      const result = run(directory);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.trim(), 'package.json:1: package version must be a three-integer version');
    });
  });
}

test('unreadable package.json produces one violation instead of throwing', async () => {
  await fixture({ package: null }, (directory) => {
    fs.mkdirSync(path.join(directory, 'package.json'));
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), 'package.json:1: package version must be a three-integer version');
  });
});
