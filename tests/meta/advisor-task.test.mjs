import assert from 'node:assert/strict';
import test from 'node:test';
import { advisorTaskRefusal, parseAdvisorTask } from '../../src/home/lib/meta/advisor-task.mjs';

const TASK = `## Question
Which design fits the existing boundary?

## Options
- keep: Keep the existing module
- split-2: Split the boundary into two modules

## Paths
- src/home/lib/meta/verdict.mjs
- src/home/lib/runner
`;

test('parses the fixed task format and ignores other sections', () => {
  const text = TASK + '\n## Notes\n- ignored: Prefer this unrelated note\n';
  assert.deepEqual(parseAdvisorTask(text), {
    options: [
      { id: 'keep', description: 'Keep the existing module' },
      { id: 'split-2', description: 'Split the boundary into two modules' },
    ],
    paths: ['src/home/lib/meta/verdict.mjs', 'src/home/lib/runner'],
  });
  assert.equal(advisorTaskRefusal(text), null);
});

test('supports CRLF, numbered ids, trimmed descriptions and Windows path spelling', () => {
  const text = '## Options\r\n- 1-a:  First: detailed description  \r\n- b--: Second\r\n' +
    '## Paths\r\n- .\\src\\entry.mjs  \r\n';
  assert.deepEqual(parseAdvisorTask(text), {
    options: [{ id: '1-a', description: 'First: detailed description' }, { id: 'b--', description: 'Second' }],
    paths: ['.\\src\\entry.mjs'],
  });
  assert.equal(advisorTaskRefusal(text), null);
});

test('empty input has no parsed values and explicitly refuses the missing section', () => {
  assert.deepEqual(parseAdvisorTask(''), { options: [], paths: [] });
  assert.match(advisorTaskRefusal(''), /Options.*## Options.*two/);
  assert.equal(advisorTaskRefusal(TASK), null);
});

const INVALID_TASKS = [
  ['missing Options', TASK.replace('## Options', '## Alternatives'), /Options.*## Options/],
  ['no options', TASK.replace(/- keep:.*\n- split-2:.*\n/, ''), /Options line 4.*two/],
  ['one option', TASK.replace(/- split-2:.*\n/, ''), /Options line 4.*two/],
  ['duplicate id', TASK.replace('- split-2:', '- keep:'), /Options line 6.*duplicate.*keep/],
  ['missing Paths', TASK.replace('## Paths', '## Files'), /Paths.*## Paths/],
  ['empty Paths', TASK.slice(0, TASK.indexOf('## Paths')) + '## Paths\n', /Paths line 8.*at least one/],
  ['blank path item', TASK.slice(0, TASK.indexOf('## Paths')) + '## Paths\n-   \n', /Paths line 8/],
];
for (const [name, text, reason] of INVALID_TASKS) {
  test(`refuses ${name} and accepts a corrected task`, () => {
    assert.match(advisorTaskRefusal(text), reason);
    assert.equal(advisorTaskRefusal(TASK), null);
  });
}

for (const id of ['UPPER', 'under_score', '-leading', 'with space', '', 'текст', 'a.b']) {
  test(`refuses malformed option id ${JSON.stringify(id)} with its source line`, () => {
    const text = TASK.replace('- keep:', `- ${id}:`);
    const refusal = advisorTaskRefusal(text);
    assert.match(refusal, /Options line 5/);
    assert.ok(refusal.includes(`- ${id}: Keep the existing module`));
    assert.match(refusal, /option-id.*\[a-z0-9\]/);
    assert.equal(advisorTaskRefusal(TASK), null);
  });
}

for (const marker of ['recommend', 'Recommended', 'prefer', 'PREFERRED', 'РЕКОМЕНДУЮ', 'предпочтительно', '(✓)', '★']) {
  test(`D5 refuses ${marker} anywhere in Options and allows it outside that section`, () => {
    for (const insertion of [`- keep: ${marker} this design`, `### Notes\n${marker} this design`]) {
      const text = TASK.replace('- keep: Keep the existing module', insertion);
      const refusal = advisorTaskRefusal(text);
      assert.match(refusal, /Options line \d+.*preference marker.*D5/);
      assert.ok(refusal.includes(marker), refusal);
    }
    assert.equal(advisorTaskRefusal(TASK.replace('Which design', `${marker}: Which design`)), null);
    assert.equal(advisorTaskRefusal(TASK + `\n## Notes\n${marker}\n`), null);
  });
}

test('a preference marker on a non-option line is not skipped', () => {
  const text = TASK.replace('## Paths', 'We prefer the first approach.\n\n## Paths');
  assert.match(advisorTaskRefusal(text), /line 8.*We prefer the first approach/);
  assert.equal(advisorTaskRefusal(TASK), null);
});

test('repeated Options sections cannot hide duplicates or preference markers', () => {
  assert.match(advisorTaskRefusal(TASK + '\n## Options\n- keep: Another design\n'), /duplicate.*keep/);
  assert.match(advisorTaskRefusal(TASK + '\n## Options\nRecommended here\n'), /preference marker/);
  assert.equal(advisorTaskRefusal(TASK), null);
});

test('missing required text is not silently replaced', () => {
  assert.throws(() => parseAdvisorTask(), /text must be a string/);
  assert.throws(() => advisorTaskRefusal(null), /text must be a string/);
});
