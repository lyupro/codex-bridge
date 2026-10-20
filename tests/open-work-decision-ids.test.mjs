/** Guards Plan_80 E29: a decision reference must identify one entry across a whole plan. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempTree } from './temp-tree.mjs';
import { checkDecisionIds } from '../scripts/open-work/decision-ids.mjs';
import { validateOpenWork } from '../scripts/open-work/check.mjs';

const heading = '## Decisions';
const plan = 'docs/plans/Plan_80.md';

async function fixture(files, work) {
  return withTempTree('open-work-decision-ids-', async (directory) => {
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, 'utf8');
    }
    return work(directory);
  });
}

test('unique decision IDs, including prefixes and lowercase suffixes, pass', async () => {
  await fixture({ [plan]: `${heading}\n${['E25', 'E24a', 'D4', 'RT-D19', 'A19', 'ABC-XYZ123z']
    .map((id) => `- **${id} — Decision.**`).join('\n')}\n` }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), []);
  });
});

test('repeated E25 across sections reports both line numbers in both validation modes', async () => {
  const text = `# Plan\r\n\r\n${heading}\r\n- **E25 — a\r\n## Later decisions\r\n- **E25 — b\r\n`;
  await fixture({ [plan]: text }, (directory) => {
    const violation = `${plan}:4: decision id E25 repeats at lines 4, 6`;
    assert.deepEqual(checkDecisionIds(directory), [violation]);
    for (const strict of [false, true]) {
      const result = validateOpenWork(directory, { strict });
      assert.ok(result.violations.includes(violation));
      assert.ok(!result.notices.includes(violation));
    }
  });
});

test('entries before headings and below level-three headings count across the whole plan', async () => {
  await fixture({ [plan]: `# Plan\n- **E25 — Before.**\n${heading} (ledger)\n`
    + '### Group\n- **E25 — Decision.**\n## Other\n- **E25 — Journal.**\n' }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), [`${plan}:2: decision id E25 repeats at lines 2, 5, 7`]);
  });
  await fixture({ [plan]: `${heading}\n- **E25 — First.**\n### Group\n- **E25 — Second.**\n` }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), [`${plan}:2: decision id E25 repeats at lines 2, 4`]);
  });
});

test('dated journal entries do not collide with a decision', async () => {
  await fixture({ [plan]: `${heading}\n- **R1 (2026-10-20) — Journal.**\n`
    + '- **R1 (2026-10-20 ~15:08) — Journal.**\n- **R1 — Decision.**\n' }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), []);
  });
});

test('plans without a decision ledger still detect duplicate decisions', async () => {
  await fixture({ [plan]: '# Plan\n## Other\n- **E25 — First.**\n- **E25 — Second.**\n' }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), [`${plan}:3: decision id E25 repeats at lines 3, 4`]);
  });
});

test('missing plans folder passes the decision check and normal fresh-clone validation', async () => {
  await fixture({}, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), []);
    assert.deepEqual(validateOpenWork(directory).violations, []);
  });
});

for (const [id, entry] of [
  ['D4', '- **D4 — text'],
  ['D4', '- **D4. Title.**'],
  ['RT-D19', '- **RT-D19 — text'],
  ['E24a', '- **E24a — text'],
]) {
  test(`recognizes repeated decisions in the format ${entry}`, async () => {
    await fixture({ [plan]: `${heading}\n${entry}\n${entry}\n` }, (directory) => {
      assert.deepEqual(checkDecisionIds(directory), [`${plan}:2: decision id ${id} repeats at lines 2, 3`]);
    });
  });
}

for (const [entry, decision] of [
  ['- **D4.** check', '- **D4. Title.**'],
  ['- **B10** — step', '- **B10 — decision'],
  ['- **R1 (2026-10-20) — journal', '- **R1 — decision'],
  ['- **D4. — text', '- **D4. Title.**'],
]) {
  test(`excludes non-decision entry ${entry}`, async () => {
    await fixture({ [plan]: `${heading}\n${entry}\n${decision}\n` }, (directory) => {
      assert.deepEqual(checkDecisionIds(directory), []);
    });
  });
}

test('reports one violation per repeated ID with all locations', async () => {
  await fixture({ [plan]: `${heading}\n- **E25 — First\n- **D4. Text.**\n`
    + '- **E25 — Second\n- **D4. Another title.**\n- **E25. Third title.**\n' }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), [
      `${plan}:2: decision id E25 repeats at lines 2, 4, 6`,
      `${plan}:3: decision id D4 repeats at lines 3, 5`,
    ]);
  });
});

test('only top-level Plan_*.md files are checked and IDs are local to each file', async () => {
  const unique = `${heading}\n- **E25 — Decision.**\n`;
  const duplicate = `${unique}- **E25 — Duplicate.**\n`;
  await fixture({
    [plan]: unique,
    'docs/plans/Plan_81.md': unique,
    'docs/plans/nested/Plan_82.md': duplicate,
    'docs/plans/Other.md': duplicate,
    'docs/plans/Plan_83.txt': duplicate,
  }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), []);
  });
});

test('IDs outside the fixed grammar and lines without the decision prefix are ignored', async () => {
  const entries = ['E25aa', 'ABCD1', 'A-BCDE1', 'e25', 'A-B-C1', 'E25x1'];
  const lines = entries.flatMap((id) => [`- **${id} — Text`, `- **${id} — Text`]);
  lines.push('  - **E25 — Indented', '* **E25 — Other bullet', '- E25 — Plain', '- **E25 (journal)');
  await fixture({ [plan]: `${heading}\n${lines.join('\n')}\n- **E25 — Decision\n` }, (directory) => {
    assert.deepEqual(checkDecisionIds(directory), []);
  });
});
