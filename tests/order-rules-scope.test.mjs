/** Plan_79 B4b: scope header rules preserve refusal bytes and classify caller inputs under D6. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_RULES, orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { RULES as HEADER_RULES } from '../src/home/lib/order-rules/header.mjs';
import { validateScope } from '../src/home/lib/runner/scope-check.mjs';
import { ADMISSION_FILES, PENDING_MIGRATION } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';

// Plan_79 B4b: these literal pairs copy the scope-check sites, not the new registry implementation.
const shapeMessages = [
  ['line-break', {}, 'contains a newline or carriage return',
    'use a glob instead of a literal path containing a line break'],
  ['absolute', {}, 'is an absolute or drive-qualified path',
    'use a path relative to the repository root with forward slashes'],
  ['backslash', {}, 'uses backslash separators', 'replace backslashes with forward slashes'],
  ['parent-directory', {}, 'contains a parent-directory (..) segment',
    'remove the .. segment and keep the path relative to the repository root'],
  ['service-directory', {}, 'lies inside a service directory that no scope can authorise',
    'name the file outside the service directory, or make that edit yourself'],
  ['directory', { pattern: 'muse/scripts' }, 'names a directory rather than a file',
    'write muse/scripts/** for everything inside it, or name the file itself'],
  ['directory', { pattern: 'muse/scripts/' }, 'names a directory rather than a file',
    'write muse/scripts/** for everything inside it, or name the file itself'],
  ['directory', { pattern: 'absent.mjs/' }, 'names a directory rather than a file',
    'write absent.mjs/** for everything inside it, or name the file itself'],
  ['directory', { pattern: 'areas/Ω file/' }, 'names a directory rather than a file',
    'write areas/Ω file/** for everything inside it, or name the file itself'],
  ['new-directory', { pattern: 'Makefile' }, 'names a directory rather than a file',
    'write Makefile/** if it is a directory, or declare the new file by its own name with an extension; a new extensionless file is declared through its directory'],
];
const matchMessages = [
  ['missing', { labelName: '`scope new:`' }, 'does not match any existing path in the repository',
    'correct the pattern or declare an intentionally new path with `scope new:`'],
  ['not-repository', { repoRoot: 'C:/work/Ω repo', labelName: '`repository:`' },
    'does not match any existing path under C:/work/Ω repo; ' +
      'git could not list that folder as a repository, so it was walked instead',
    'start the run from the repository root (cd into it, or pass `repository:` <repository root>); ' +
      'if this folder is the intended one, correct the pattern'],
  ['invalid-glob', { message: 'invalid scope glob' }, 'could not parse the pattern: invalid scope glob',
    'correct the pattern and retry'],
  ['non-utf8', { message: 'Repository C:/work/repo contains a file name that is not UTF-8' },
    'Repository C:/work/repo contains a file name that is not UTF-8',
    'rename the non-UTF-8 file using a UTF-8 file name and retry'],
];

for (const [key, messages] of [
  ['scope-pattern-shape', shapeMessages], ['scope-pattern-match', matchMessages],
]) {
  for (const [violation, values, reason, action] of messages) {
    for (const [part, expected] of [['reason', reason], ['action', action]]) {
      test(`${key} ${violation} ${part} ${JSON.stringify(values)} preserves literal text`, () => {
        assert.equal(orderRuleMessage(key, { ...values, violation, part }), expected);
        assert.equal(ORDER_RULES[key].message({ ...values, violation, part }), expected);
      });
    }
  }
}

test('two frozen header rules own the scope shape and match refusal pairs with explicit data', () => {
  for (const [key, data] of [
    ['scope-pattern-shape', ['violation', 'part', 'pattern']],
    ['scope-pattern-match', ['violation', 'part', 'repoRoot', 'labelName', 'message']],
  ]) {
    const entry = ORDER_RULES[key];
    assert.equal(entry, HEADER_RULES[key]);
    assert.equal(entry.topic, 'order');
    assert.ok(entry.rule.trim());
    assert.doesNotMatch(entry.rule, /\{\{/);
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.data));
    assert.deepEqual(entry.data, data);
  }
});

test('scope selectors refuse absent and unknown violations or parts without a default', () => {
  for (const [key, messages] of [
    ['scope-pattern-shape', shapeMessages], ['scope-pattern-match', matchMessages],
  ]) {
    for (const violation of [undefined, 'unknown', 'toString', '__proto__']) {
      for (const part of ['reason', 'action']) {
        assert.throws(() => orderRuleMessage(key, { violation, part }), {
          message: `unknown ${key} violation: ${violation}`,
        });
      }
    }
    for (const [violation, values] of messages) {
      for (const part of [undefined, 'unknown', 'toString', '__proto__']) {
        assert.throws(() => orderRuleMessage(key, { ...values, violation, part }), {
          message: `unknown ${key} part: ${part}`,
        });
      }
    }
  }
});

test('scope-check passes the static admission guard without pending migration or opt-outs', () => {
  const file = 'src/home/lib/runner/scope-check.mjs';
  assert.ok(ADMISSION_FILES.includes(file));
  assert.ok(!PENDING_MIGRATION.has(file));
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
  assert.doesNotMatch(source, /recordOrderText|pending producer/);
});

test('structural scope objects preserve both labels, property order and refusal priority', () => {
  const repoRoot = makeTempTree('order-rules-scope-objects-');
  const patterns = [
    ['line-break', 'src/a\nb.mjs'], ['absolute', '/src/a.mjs'],
    ['backslash', 'src\\a.mjs'], ['parent-directory', 'src/../a.mjs'],
    ['service-directory', '.git/config'], ['directory', 'muse/scripts/'],
    ['new-directory', 'Makefile'],
  ];
  for (const [violation, pattern] of patterns) {
    const [, , reason, action] = shapeMessages.find(([name]) => name === violation);
    for (const label of ['scope', 'scope new']) {
      const refusal = validateScope(repoRoot, label === 'scope' ? [pattern] : ['missing.mjs'],
        label === 'scope new' ? [pattern] : []);
      assert.deepEqual(refusal, { pattern, label, reason, action });
      assert.deepEqual(Object.keys(refusal), ['pattern', 'label', 'reason', 'action']);
    }
  }
  assert.deepEqual(validateScope(repoRoot, [''], []), {
    pattern: '', reason: 'does not match any existing path in the repository',
    action: 'correct the pattern or declare an intentionally new path with `scope new:`', label: 'scope',
  });
  assert.equal(validateScope(repoRoot, [], ['new.mjs']), null);
});

// Plan_79 D6: the intentional unknown parameter belongs to a child marker, never the suite journal.
test('valid scope data records both texts and an unknown parameter journals a parameter violation', () => {
  const root = path.join(makeTempTree('order-rules-scope-params-'), 'marker');
  const rules = new URL('../src/home/lib/order-rules.mjs', import.meta.url).href;
  const recorder = new URL('../src/home/lib/order-text-record.mjs', import.meta.url).href;
  const schema = new URL('../src/home/lib/order-schema.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { orderRuleMessage } from ${JSON.stringify(rules)};
    import { checkOutgoingRefusal } from ${JSON.stringify(recorder)};
    import { orderInputName } from ${JSON.stringify(schema)};
    for (const [key, messages] of ${JSON.stringify([
      ['scope-pattern-shape', shapeMessages], ['scope-pattern-match', matchMessages],
    ])}) {
      for (const [violation, values, reason, action] of messages) {
        for (const [part, expected] of [['reason', reason], ['action', action]]) {
          const output = orderRuleMessage(key, { ...values, violation, part });
          assert.equal(output, expected);
          checkOutgoingRefusal(output, 'scope-probe');
        }
      }
    }
    const action = orderRuleMessage('scope-pattern-match', {
      violation: 'missing', part: 'action', labelName: orderInputName('scope new'),
    });
    assert.equal(action, ${JSON.stringify('correct the pattern or declare an intentionally new path with `scope new:`')});
    checkOutgoingRefusal(action, 'scope-probe');
    const output = orderRuleMessage('scope-pattern-shape', {
      violation: 'absolute', part: 'reason', unknownText: 'hand-written scope refusal',
    });
    assert.equal(output, 'is an absolute or drive-qualified path');
    checkOutgoingRefusal(output, 'scope-probe');
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const entries = fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.equal(entries.length, 1, 'allowed data and both issued texts must not journal violations');
  const [entry] = entries;
  assert.equal(entry.kind, 'parameter');
  assert.equal(entry.builder, 'orderRuleMessage');
  assert.equal(entry.key, 'scope-pattern-shape');
  assert.equal(entry.parameter, 'unknownText');
  assert.equal(entry.message, 'hand-written scope refusal');
  assert.notEqual(entry.pid, process.pid);
  assert.match(entry.stack, /checkOrderTextParameters/);
  assert.ok(entry.caller);
});
