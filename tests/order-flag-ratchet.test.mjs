/**
 * Plan_63 D5: a ratchet keeps ordinary test starts on the shared orderInvocation helper.
 * Raw parser cases retain an explicit baseline; increases require a reason, and decreases
 * must lower it so retired hand-built flags cannot quietly return before the channel switch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSpellings, orderSpellings } from './order-spelling-scan.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXCLUDED = new Set([
  'tests/order-spelling-scan.mjs',
  'tests/runner/order-invocation.mjs',
  'tests/order-flag-ratchet.test.mjs',
]);

// Plan_63 D9 G4: reviewed decreases after the task-file switch; never regenerate at test time.
const BASELINE = {
  'tests/cli/codex-bridge.test.mjs': 1,
  // +2 (Plan_67 N1b): `--scope user|project` of `inventory confirm` is the install scope, not the order scope.
  'tests/cli/commands.test.mjs': 3,
  'tests/cli/model-concurrent-edits.test.mjs': 3,
  'tests/cli/model.test.mjs': 5,
  'tests/cli/uninstall-purge.test.mjs': 1,
  'tests/dispatcher-call.test.mjs': 4,
  'tests/dispatcher-command.test.mjs': 2,
  'tests/dispatcher-gate.test.mjs': 0,
  'tests/mode-is-not-a-name.test.mjs': 1,
  'tests/required-inputs.test.mjs': 0,
  'tests/runner/advisor-run.test.mjs': 1,
  'tests/runner/args-refusal-order.test.mjs': 7,
  'tests/runner/continuation-grant.test.mjs': 3,
  'tests/runner/continuation.test.mjs': 2,
  'tests/runner/phase.test.mjs': 1,
  'tests/runner/retry-grant.test.mjs': 1,
  'tests/runner/scope.test.mjs': 3,
  'tests/runner/shell-unsafe.test.mjs': 1,
  'tests/shell-unsafe-arguments.test.mjs': 0,
};

function moduleFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(file);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [file] : [];
  }).sort();
}

test('Plan_63 D5 ratchets hand-built order flags across every test module', () => {
  const counts = new Map();
  for (const file of moduleFiles(path.join(ROOT, 'tests'))) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (EXCLUDED.has(relative)) continue;
    counts.set(relative, findSpellings(fs.readFileSync(file, 'utf8'), relative).length);
  }
  const failures = [];
  for (const file of new Set([...Object.keys(BASELINE), ...counts.keys()])) {
    const expected = BASELINE[file] ?? 0;
    const actual = counts.get(file) ?? 0;
    if (actual > expected) {
      failures.push(`${file}: order-flag count increased from ${expected} to ${actual}; `
        + 'build the order with orderInvocation from tests/runner/order-invocation.mjs, or, '
        + 'if the command line itself is the subject, mark the case // raw argv: '
        + 'and raise the number with the reason in the commit.');
    } else if (actual < expected) {
      failures.push(`${file}: order-flag count decreased from ${expected} to ${actual}; lower the number.`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the ratchet counter ignores comments and counts flag spellings in code', () => {
  const spelling = orderSpellings()[0];
  const source = `// ${spelling}\n/* ${spelling}\n${spelling} */\nconst flag = '${spelling}';`;
  assert.deepEqual(findSpellings(source, 'inline.mjs'), [
    { file: 'inline.mjs', line: 4, spelling },
  ]);
});
