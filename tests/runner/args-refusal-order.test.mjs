/**
 * Guards the order in which the flag parser refuses (Plan_63 D5): moving value normalisation into
 * runner/order-options.mjs must not let a later refusal overtake an earlier one before the channel switch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const ARGS_MODULE = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;
const ORDER = ['--order-id', 'ord-1'];

/** parseArgs refuses by exiting, so it is asked in a child and judged by the exit code. */
function parseArgsInChild(argv) {
  const source = `import { parseArgs } from ${JSON.stringify(ARGS_MODULE)};
try { parseArgs(JSON.parse(process.env.CODEX_TEST_ARGV)); } catch (err) { process.exit(err.exitCode || 1); }`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_TEST_ARGV: JSON.stringify(argv) },
  });
  return { code: out.status, stderr: out.stderr || '' };
}

test('Plan_63 D5 preserves refusal precedence before the flag channel switches', () => {
  const cases = [
    { argv: ['--agent', 'unknown', '--order-id', '...'], refusal: 'unknown --agent unknown' },
    { argv: ['--no-wait', '--continue'], refusal: '--agent is required' },
    { argv: ['--agent', 'codex-scout', '--no-wait', '--continue'], refusal: '--no-wait cannot be combined' },
    { argv: ['--agent', 'codex-scout', '--question', '', '--effort', 'two words'], refusal: '--order-id is required' },
    { argv: ['--agent', 'codex-scout', '--order-id', '...', '--question', '', '--effort', 'two words'],
      refusal: '--question must not be empty' },
    { argv: ['--agent', 'codex-scout', '--order-id', '...', '--effort', 'two words'],
      refusal: '--effort must be a non-empty single word' },
    { argv: ['--agent', 'codex-scout', '--order-id', '...', '--scope-new', 'new.mjs'],
      refusal: '--order-id produces an unusable run folder name' },
    { argv: ['--agent', 'codex-scout', ...ORDER, '--scope-new', 'new.mjs'],
      refusal: '--scope-new is only for codex-build' },
    { argv: ['--agent', 'codex-build', ...ORDER, '--scope', ', ,', '--scope-new', 'new.mjs'],
      refusal: '--scope is required for codex-build' },
    { argv: ['--agent', 'codex-review', '--order-id', '...', '--slug', ''],
      refusal: '--order-id produces an unusable run folder name' },
    { argv: ['--agent', 'codex-review', ...ORDER, '--slug', '___'],
      refusal: '--slug produces an unusable run folder name' },
    { argv: ['--agent', 'codex-scout', '--order-id', '...', '--effort', '$(echo)'],
      refusal: '--effort contains forbidden shell sequence' },
  ];
  for (const { argv, refusal } of cases) {
    const { code, stderr } = parseArgsInChild(argv);
    assert.equal(code, 2, JSON.stringify(argv));
    assert.ok(stderr.startsWith('run-codex: ' + refusal), stderr);
  }
});
