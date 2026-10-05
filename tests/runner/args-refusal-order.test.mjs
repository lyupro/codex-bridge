/** Plan_63 D8 closes every order flag before the task header is read. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const ARGS_MODULE = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;

/** parseArgs refuses by exiting, so it is asked in a child and judged by the exit code. */
function parseArgsInChild(argv) {
  const source = `import { parseArgs } from ${JSON.stringify(ARGS_MODULE)};
try { parseArgs(JSON.parse(process.env.CODEX_TEST_ARGV)); } catch (err) { process.exit(err.exitCode || 1); }`;
  // raw argv: Node runs the isolated transport parser to capture its exit code.
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_TEST_ARGV: JSON.stringify(argv) },
  });
  return { code: out.status, stderr: out.stderr || '' };
}

test('Plan_63 D8 refuses each closed order and section flag before task loading', () => {
  for (const flag of [
    '--repo', '--order-id', '--scope', '--scope-new', '--slug', '--effort', '--phase',
    '--question', '--verify',
  ]) {
    // raw argv: one refusal per closed flag replaces obsolete inter-flag validation precedence.
    const argv = ['--agent', 'codex-scout', flag, 'value'];
    const { code, stderr } = parseArgsInChild(argv);
    assert.equal(code, 2, flag);
    assert.ok(stderr.startsWith('run-codex: unknown flag ' + flag + ':'), stderr);
  }
});

test('allowed transport still requires a known agent before task loading', () => {
  // raw argv: missing and unknown agents exercise the surviving transport contract only.
  for (const [argv, refusal] of [
    [[], '--agent is required'],
    [['--agent', 'unknown'], 'unknown --agent unknown'],
  ]) {
    const { code, stderr } = parseArgsInChild(argv);
    assert.equal(code, 2, stderr);
    assert.ok(stderr.startsWith('run-codex: ' + refusal), stderr);
  }
});
