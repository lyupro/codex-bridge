/** OW-075 A3a: callers choose the action by cause and every migrated refusal ends in one row. */
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation } from './order-invocation.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { resolveRunPhase } from '../../src/home/lib/runner/preflight.mjs';
import assert from 'node:assert/strict';
import { die, RunnerUsageError, withActionRow } from '../../src/home/lib/runner/args.mjs';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';

const action = orderDiagnosticMessage('next-action', { variant: 'usage' });

test('withActionRow appends the expected row as the last line', () => {
  for (const ending of ['', '\n', '\n\n', '\r\n']) {
    assert.equal(withActionRow(`refusal${ending}`, 'usage'), `refusal\n${action}`);
  }
  assert.equal(withActionRow('', 'usage'), action);
});

test('withActionRow relocates one matching row and preserves the other lines', () => {
  assert.equal(withActionRow(`refusal\n${action}\nheader help\nquota row`, 'usage'),
    `refusal\nheader help\nquota row\n${action}`);
  assert.equal(withActionRow(`refusal\n${action}`, 'usage'), `refusal\n${action}`);
  assert.equal(withActionRow(action, 'usage'), action);
  assert.equal(withActionRow(`refusal\r\n${action}\r\nhelp\r\n`, 'usage'), `refusal\nhelp\n${action}`);
});

test('withActionRow rejects duplicate or conflicting standalone rows', () => {
  const other = orderDiagnosticMessage('next-action', { variant: 'runner-fault' });
  for (const text of [`${action}\n${action}`, `${action}\n${other}`, other]) {
    assert.throws(() => withActionRow(text, 'usage'), {
      name: 'Error', message: 'refusal carries a conflicting Action row',
    });
  }
});

test('withActionRow preserves inline Action text without counting it as a row', () => {
  const text = 'refusal with inline Action: explanation\n Action: indented text\nAction:without a space';
  assert.equal(withActionRow(text, 'usage'), `${text}\n${action}`);
});

test('withActionRow leaves unknown variant rejection to the diagnostic', () => {
  for (const variant of [undefined, 'unknown']) {
    assert.throws(() => withActionRow('refusal', variant), {
      message: `unknown next-action variant: ${variant}`,
    });
  }
});

test('die object form prints and throws the full message with exactly one final Action row', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  for (const options of [{ action: 'usage' }, { action: 'usage', exit: EXIT.FAIL }]) {
    const expected = `${message}\n${action}`;
    assert.throws(() => die(message, options), (error) => {
      assert.ok(error instanceof RunnerUsageError);
      assert.equal(error.message, expected);
      assert.equal(error.exitCode, options.exit ?? EXIT.USAGE);
      assert.deepEqual(error.message.split('\n').filter((line) => line.startsWith('Action: ')), [action]);
      assert.equal(error.message.split('\n').at(-1), action);
      return true;
    });
    assert.deepEqual(printed.mock.calls.at(-1).arguments, [`run-codex: ${expected}`]);
  }
  assert.equal(printed.mock.callCount(), 2);
});

test('die uses the caller variant independently of the exit code and relocates its row', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  const row = orderDiagnosticMessage('next-action', { variant: 'runner-fault' });
  const expected = `${message}\n${row}`;
  assert.throws(() => die(`${row}\n${message}`, { action: 'runner-fault', exit: EXIT.USAGE }), {
    name: 'Error', message: expected, exitCode: EXIT.USAGE,
  });
  assert.deepEqual(printed.mock.calls[0].arguments, [`run-codex: ${expected}`]);
});

test('die requires an action in object form before printing', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  for (const options of [{}, { exit: EXIT.FAIL }, { action: undefined }]) {
    assert.throws(() => die(orderDiagnosticMessage('agent-required'), options), {
      name: 'Error', message: 'die() needs a next-action variant',
    });
  }
  assert.equal(printed.mock.callCount(), 0);
});

test('die explicit action forms retain their exit codes and add one Action row', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  for (const exit of [EXIT.FAIL, EXIT.USAGE, EXIT.OK, undefined]) {
    assert.throws(() => die(message, { action: 'usage', exit }), (error) => {
      assert.ok(error instanceof RunnerUsageError);
      assert.equal(error.message, `${message}\n${action}`);
      assert.equal(error.exitCode, exit ?? EXIT.USAGE);
      assert.deepEqual(error.message.split('\n').filter((line) => line.startsWith('Action: ')), [action]);
      return true;
    });
    assert.deepEqual(printed.mock.calls.at(-1).arguments, [`run-codex: ${message}\n${action}`]);
  }
  assert.equal(printed.mock.callCount(), 4);
});

test('die rejects conflicting rows and unknown variants before printing', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  assert.throws(() => die(`${action}\n${action}`, { action: 'usage' }), {
    message: 'refusal carries a conflicting Action row',
  });
  assert.throws(() => die(orderDiagnosticMessage('agent-required'), { action: 'unknown' }), {
    message: 'unknown next-action variant: unknown',
  });
  assert.equal(printed.mock.callCount(), 0);
});

test('die with an action preserves the default usage exit', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  assert.throws(() => die(message, { action: 'usage' }), { name: 'Error', message: `${message}\n${action}`, exitCode: EXIT.USAGE });
  assert.deepEqual(printed.mock.calls[0].arguments, [`run-codex: ${message}\n${action}`]);
});

// OW-075 A3b: exercise the actual launcher call sites, including the free unsupported-platform race.
for (const [cause, variant, exit] of [
  ['claim', 'run-in-progress', EXIT.FAIL], ['race', 'run-in-progress', EXIT.FAIL],
  ['detached', 'repository-detached', EXIT.USAGE], ['scope', 'usage', EXIT.USAGE],
  ['readiness', 'readiness-unconfirmed', EXIT.FAIL],
  ['availability', 'availability-unconfirmed', EXIT.FAIL],
]) {
  test(`launcher ${cause} chooses its final action by cause and preserves exit ${exit}`, () => {
    const root = makeTempTree('refusal-action-');
    const repo = path.join(root, 'repo');
    const runs = path.join(root, 'runs');
    const home = path.join(root, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    const project = resolveProjectRunsDir(runs, repo).dir;
    const orderId = 'action-fixture';
    if (cause === 'detached') {
      const abandoned = path.join(project, 'abandoned-run');
      fs.mkdirSync(abandoned);
      fs.writeFileSync(path.join(abandoned, 'status.json'), JSON.stringify({ state: 'abandoned', repo }));
      fs.writeFileSync(path.join(abandoned, 'branch-before.txt'), 'feature/original\n');
    }
    const { argv } = orderInvocation({
      agent: cause === 'scope' ? 'codex-build' : 'codex-review',
      order: { repository: repo, 'order id': orderId, ...(cause === 'scope' ? { scope: 'missing.mjs' } : {}) },
      advice: cause === 'scope' ? 'mechanical' : undefined, task: 'Inspect the refusal fixture.', dir: root,
    });
    const launcher = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
    const moduleUrl = (name) => new URL(`../../src/home/lib/${name}`, import.meta.url).href;
    const wrappers = {};
    if (cause === 'claim' || cause === 'race') {
      wrappers['./order-claim.mjs'] = `export * from ${JSON.stringify(moduleUrl('runner/order-claim.mjs'))};
export async function acquireOrderClaim() { return ${cause === 'claim'
  ? '{ busy: true, holder: null }' : '{ unsupported: true, release: async () => {} }'}; }`;
    }
    if (cause === 'race') {
      wrappers['../retention.mjs'] = `import fs from 'node:fs'; import path from 'node:path';
export function cleanupRetention(root) {
  const late = path.join(root, 'late-run'); fs.mkdirSync(late);
  fs.writeFileSync(path.join(late, 'status.json'), JSON.stringify({
    repo: ${JSON.stringify(repo)}, order_id: ${JSON.stringify(orderId)}, state: 'running', agent: 'codex-review', pid: process.pid,
  }));
  return null;
}`;
    }
    if (cause === 'detached') {
      wrappers['./git-state.mjs'] = `export * from ${JSON.stringify(moduleUrl('runner/git-state.mjs'))};
export const git = () => ({ status: 0, stdout: ${JSON.stringify(repo)} });
export const branchName = () => ''; export const worktreeSnapshot = () => '';`;
    }
    if (cause === 'readiness' || cause === 'availability') {
      const original = JSON.stringify(moduleUrl('runner/preflight.mjs'));
      wrappers['./preflight.mjs'] = `export * from ${original};
import { codexAvailabilityRefusal as original } from ${original};
export const codexAvailabilityRefusal = () => original({ probe: async () => ({
  state: 'inconclusive', pathMiss: ${cause === 'readiness'}, detail: 'fixture probe evidence',
}) });`;
    }
    const source = `
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: 'forbidden', probe: 'marker' })}
syncBuiltinESMExports();
const wrappers = ${JSON.stringify(wrappers)};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === ${JSON.stringify(launcher)} && Object.hasOwn(wrappers, specifier)) {
    return { url: 'data:text/javascript,' + encodeURIComponent(wrappers[specifier]), shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { launcher } = await import(${JSON.stringify(launcher)});
try { process.exitCode = await launcher(${JSON.stringify(argv)}); }
catch (error) { if (typeof error?.exitCode !== 'number') throw error; process.exitCode = error.exitCode; }
`;
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repo, input: '', encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_RUNS_ROOT: runs },
    });
    assert.ifError(output.error);
    assert.equal(output.status, exit, output.stderr);
    assert.equal(output.stdout, '');
    const lines = output.stderr.trimEnd().split(/\r?\n/);
    const row = orderDiagnosticMessage('next-action', { variant });
    assert.deepEqual(lines.filter((line) => line.startsWith('Action: ')), [row]);
    assert.equal(lines.at(-1), row);
    assert.match(lines.at(-2), cause === 'detached' ? /No run folder was created and no quota was spent\.$/
      : /The run folder was not created; quota was not spent\.$/);
    assert.deepEqual(fs.readdirSync(project, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => entry.name), cause === 'detached' ? ['abandoned-run'] : cause === 'race' ? ['late-run'] : []);
  });
}

test('phase resolution distinguishes missing and undeclared usage from the advise grant decision', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [phase, variant] of [[undefined, 'usage'], ['typo', 'usage'], ['advise', 'grant-decision']]) {
    assert.throws(() => resolveRunPhase({ agent: 'codex-advisor', phase, continue: false },
      { advisor: { scope: 5, advise: 15 } }), (error) => {
      assert.ok(error instanceof RunnerUsageError);
      assert.equal(error.exitCode, EXIT.USAGE);
      const lines = error.message.split('\n');
      const row = orderDiagnosticMessage('next-action', { variant });
      assert.deepEqual(lines.filter((line) => line.startsWith('Action: ')), [row]);
      assert.equal(lines.at(-1), row);
      assert.match(lines.at(-2), /The run folder was not created; quota was not spent\.$/);
      return true;
    });
  }
});
