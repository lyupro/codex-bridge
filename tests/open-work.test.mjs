/** Guards Plan_72 D1: unfinished work survives handoffs, closure, and edits to its citing plans. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withTempTree } from './temp-tree.mjs';
import { parseRegister, readRegister } from '../scripts/open-work/register.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/open-work/check.mjs');
// The CLI imports the package's one same-file judge, so a fixture copy carries it along.
const sources = new Map([
  'scripts/open-work/register.mjs', 'scripts/open-work/check.mjs', 'cli/invoked-directly.mjs',
].map((relative) => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]));
const registerPath = 'docs/plans/open-work.md';

function item({ id = 'OW-001', state = 'open', owner = 'агент', home = 'docs/plans/Plan.md', extra = '' } = {}) {
  return `### ${id} — A task
- состояние: ${state}
- владелец: ${owner}
- источник: A handoff
- дом: ${home}
- следующий шаг: Run the next step${extra ? `\n${extra}` : ''}`;
}

function register(rows = [item()], queue = []) {
  return `# Workroom

Introductory prose is free text, even OW-999.

## Очередь
${queue.map((id, index) => `${index + 1}. ${id} — Next`).join('\n')}

## Не упорядочено
Free text and OW-998 are not queue entries.
1. OW-998 — This is not the queue.

## Пункты

${rows.join('\n\n')}
`;
}

async function fixture(options, work) {
  return withTempTree('open-work-', async (directory) => {
    const folders = options.folders ?? ['docs/plans', 'docs/checklists'];
    for (const folder of folders) fs.mkdirSync(path.join(directory, folder), { recursive: true });
    const files = { ...(options.files ?? { 'docs/plans/Plan.md': '# Plan\n\nSee OW-001.\n' }) };
    if (options.register !== null) files[registerPath] = options.register ?? register();
    // Copy only the validator: CLI fixtures exercise its own root without adding a root override.
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

function fails(result, problems) {
  assert.equal(result.status, 1, result.stdout);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, problems.length, result.stdout);
  for (const [index, problem] of problems.entries()) {
    assert.match(lines[index], /^[^\r\n]+:\d+: .+$/);
    assert.ok(lines[index].endsWith(`: ${problem}`), result.stdout);
  }
}

test('parser retains item, field, continuation, and queue line numbers without judging values', () => {
  const parsed = parseRegister('## Очередь\r\n1. OW-1234 — Task\r\n\r\n### OW-1234 — Title\r\n'
    + '- состояние: invented\r\n- unfamiliar: one\r\n  two\r\n- unfamiliar: again\r\n');
  assert.deepEqual(parsed.queue, [{ id: 'OW-1234', line: 2 }]);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, 'OW-1234');
  assert.equal(parsed.items[0].title, 'Title');
  assert.equal(parsed.items[0].line, 4);
  assert.deepEqual(parsed.items[0].fields[1], {
    key: 'unfamiliar', value: 'one\ntwo', line: 6,
    valueLines: [{ value: 'one', line: 6 }, { value: 'two', line: 7 }],
  });
  assert.equal(parsed.items[0].fields[2].line, 8);
});

test('valid register accepts every state, owner, home form, and continued value', async () => {
  const text = register([
    item({ home: 'docs/plans/Plan.md; [checklist](../checklists/nested/Checklist.md#step)',
      extra: '  Continue the next step.\n- доказательство: Optional evidence' }),
    item({ id: 'OW-002', state: 'blocked', owner: 'оператор', home: 'Not a file yet', extra: '- блокер: Waiting' }),
    item({ id: 'OW-003', state: 'done', home: '[plan](Plan.md)', extra: '- доказательство: Commit abc' }),
    item({ id: 'OW-1234', state: 'cancelled', home: '[plan](<Plan.md> "Title")',
      extra: '- доказательство:\n  Replaced with a newer task' }),
  ], ['OW-001', 'OW-002']).replace('## Очередь\n', '## Очередь (исполняется сверху вниз)\n');
  await fixture({ register: text, files: {
    'docs/plans/Plan.md': 'OW-001 OW-002 OW-003 OW-1234',
    'docs/checklists/nested/Checklist.md': 'OW-002',
  } }, (directory) => {
    const parsed = readRegister(path.join(directory, registerPath));
    assert.equal(parsed.items.length, 4);
    for (const strict of [false, true]) {
      const result = run(directory, strict);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.stdout, '');
    }
  });
});

test('rule 1: missing register is a violation when both folders exist', async () => {
  await fixture({ register: null }, (directory) => {
    for (const strict of [false, true]) fails(run(directory, strict), ['register is missing']);
  });
});

test('rule 1: register with no item fails', async () => {
  await fixture({ register: '# Only prose\n', files: {} }, (directory) => {
    fails(run(directory), ['register must contain at least one item']);
  });
});

test('rule 1: duplicate ids fail at the second heading', async () => {
  const text = register([item(), item()]);
  await fixture({ register: text }, (directory) => {
    const result = run(directory);
    fails(result, ['duplicate item id OW-001']);
    const line = text.split('\n').findLastIndex((value) => value.startsWith('### OW-001')) + 1;
    assert.equal(result.stdout.trim(), `${registerPath}:${line}: duplicate item id OW-001`);
  });
});

for (const key of ['состояние', 'владелец', 'источник', 'дом', 'следующий шаг']) {
  test(`rule 2: missing required field ${key} fails`, async () => {
    const row = item().split('\n').filter((line) => !line.startsWith(`- ${key}:`)).join('\n');
    await fixture({ register: register([row]) }, (directory) => {
      fails(run(directory), [`OW-001: required field ${key} is missing or empty`]);
    });
  });
}

test('rule 2: empty required field fails', async () => {
  await fixture({ register: register([item().replace('- источник: A handoff', '- источник:')]) }, (directory) => {
    fails(run(directory), ['OW-001: required field источник is missing or empty']);
  });
});

for (const [key, value] of [['владелец', 'агент'], ['доказательство', 'A commit']]) {
  test(`rule 2: repeated field ${key} fails`, async () => {
    const extra = `${key === 'доказательство' ? `- ${key}: First\n` : ''}- ${key}: ${value}`;
    await fixture({ register: register([item({ extra })]) }, (directory) => {
      fails(run(directory), [`OW-001: repeated field ${key}`]);
    });
  });
}

test('rule 2: unknown keys fail', async () => {
  await fixture({ register: register([item({ extra: '- состояние другое: open' })]) }, (directory) => {
    fails(run(directory), ['OW-001: unknown field состояние другое']);
  });
});

test('rule 3: invalid state fails', async () => {
  await fixture({ register: register([item({ state: 'pending' })]) }, (directory) => {
    fails(run(directory), ['OW-001: invalid состояние pending']);
  });
});

test('rule 3: invalid owner fails', async () => {
  await fixture({ register: register([item({ owner: 'robot' })]) }, (directory) => {
    fails(run(directory), ['OW-001: invalid владелец robot']);
  });
});

for (const [state, required] of [['blocked', 'блокер'], ['done', 'доказательство'], ['cancelled', 'доказательство']]) {
  for (const extra of ['', `- ${required}:`]) {
    test(`rule 4: ${state} requires nonempty ${required} (${extra ? 'empty' : 'absent'})`, async () => {
      await fixture({ register: register([item({ state, extra })]) }, (directory) => {
        fails(run(directory), [`OW-001: ${state} requires ${required}`]);
      });
    });
  }
}

test('rule 5: queue cannot cite an unknown item', async () => {
  await fixture({ register: register([item()], ['OW-999']) }, (directory) => {
    fails(run(directory), ['queue names unknown item OW-999']);
  });
});

test('rule 5: queue cannot repeat an id', async () => {
  await fixture({ register: register([item()], ['OW-001', 'OW-001']) }, (directory) => {
    fails(run(directory), ['duplicate queue id OW-001']);
  });
});

for (const state of ['done', 'cancelled']) {
  test(`rule 5: ${state} item cannot be queued even with evidence`, async () => {
    await fixture({ register: register([item({ state, extra: '- доказательство: A commit' })], ['OW-001']) }, (directory) => {
      fails(run(directory), ['queue item OW-001 must be open or blocked']);
    });
  });
}

for (const home of ['docs/plans/missing.md', '[missing](missing.md)', '[missing](../checklists/missing.md#step)',
  '[missing](Missing_(plan).md)', '[missing](<Missing plan.md>)', '[missing](Missing%20plan.md)']) {
  test(`rule 6: missing home ${home} fails`, async () => {
    await fixture({ register: register([item({ home })]) }, (directory) => {
      const target = home.startsWith('docs/') ? home : decodeURIComponent(home.slice(home.indexOf('](') + 2, -1)
        .replace(/^<|>$/g, '').split('#')[0]);
      fails(run(directory), [`OW-001: home file does not exist: ${target}`]);
    });
  });
}

test('rule 6: every path is checked, including a continued home on its own source line', async () => {
  const text = register([item({ home: 'docs/plans/Plan.md\n  docs/checklists/missing.md' })]);
  await fixture({ register: text }, (directory) => {
    const result = run(directory);
    fails(result, ['OW-001: home file does not exist: docs/checklists/missing.md']);
    const line = text.split('\n').indexOf('  docs/checklists/missing.md') + 1;
    assert.equal(result.stdout.trim(), `${registerPath}:${line}: OW-001: home file does not exist: docs/checklists/missing.md`);
  });
});

test('rule 6: prose and external markdown links are not repository homes', async () => {
  const home = 'Not written; [remote](https://example.com/docs/Plan.md); '
    + 'https://example.com/docs/Other.md; [docs/plans/label.md](Plan.md); OW-999';
  await fixture({ register: register([item({ home })]) }, (directory) => {
    assert.equal(run(directory).status, 0);
  });
});

test('rule 6: a plain home followed by sentence punctuation is still checked', async () => {
  await fixture({ register: register([item({ home: 'Read docs/plans/missing.md.' })]) }, (directory) => {
    fails(run(directory), ['OW-001: home file does not exist: docs/plans/missing.md']);
  });
});

for (const file of ['docs/plans/nested/Deleted.md', 'docs/checklists/nested/Deleted.md']) {
  test(`rule 7: ${file} cannot cite a deleted register id`, async () => {
    await fixture({ files: { 'docs/plans/Plan.md': 'OW-001', [file]: '# Document\n\nSee OW-9876.\n' } }, (directory) => {
      const result = run(directory);
      fails(result, ['reference names unknown item OW-9876']);
      assert.equal(result.stdout.trim(), `${file}:3: reference names unknown item OW-9876`);
    });
  });
}

test('rule 7: every mention is checked, including code and multiple ids on one line', async () => {
  await fixture({ files: { 'docs/plans/Plan.md': 'OW-001\n`OW-888` and OW-999\n' } }, (directory) => {
    fails(run(directory), ['reference names unknown item OW-888', 'reference names unknown item OW-999']);
  });
});

test('rule 7: documents outside the workroom and non-markdown files are not scanned', async () => {
  await fixture({ files: {
    'docs/plans/Plan.md': 'OW-001', 'docs/plans/notes.txt': 'OW-999', 'docs/other/Plan.md': 'OW-999',
  } }, (directory) => assert.equal(run(directory).status, 0));
});

test('both workroom folders absent: plain mode explains its pass, strict mode fails', async () => {
  await fixture({ folders: [], register: null, files: {} }, (directory) => {
    const result = run(directory);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'Workroom is absent; nothing was checked.');
    fails(run(directory, true), [
      'workroom folder is missing (strict mode)', 'workroom folder is missing (strict mode)', 'register is missing',
    ]);
  });
});

for (const folder of ['docs/plans', 'docs/checklists']) {
  test(`only ${folder} present without register: both modes fail`, async () => {
    await fixture({ folders: [folder], register: null, files: {} }, (directory) => {
      fails(run(directory), ['register is missing']);
      fails(run(directory, true), ['workroom folder is missing (strict mode)', 'register is missing']);
    });
  });
}

test('strict mode rejects a missing checklist folder even when the register is valid', async () => {
  await fixture({ folders: ['docs/plans'] }, (directory) => {
    assert.equal(run(directory).status, 0);
    fails(run(directory, true), ['workroom folder is missing (strict mode)']);
  });
});

test('real repository register passes the CLI', (context) => {
  if (['docs/plans', 'docs/checklists'].every((directory) => !fs.existsSync(path.join(root, directory)))) {
    context.skip('Both workroom folders are absent in this public clone; there is no real register to validate.');
    return;
  }
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
