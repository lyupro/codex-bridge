/**
 * The one table of launcher refusals and the side of registration each belongs to.
 *
 * Plan_58, 2026-09-19: a busy-tree refusal created the run folder first, so inside ~/.claude —
 * where the run folders live in the worktree — the live writer's witness spent every tool call
 * demanding the orchestrator revert a directory the tool itself had created. The defect was not
 * the one misplaced check: nine refusals sat on two sides of `makeRunDir` with no rule saying
 * which side was which, and two gates of the same class (dead sandbox, busy tree) already
 * disagreed. This test is that rule. A refusal added without a row here fails it, which is the
 * point: classifying costs one line, rediscovering the incident costs a live run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) =>
  fs.readFileSync(new URL(`../../src/home/lib/runner/${relative}`, import.meta.url), 'utf8');

const LAUNCHER = read('launcher.mjs');

/**
 * `marker` is a fragment of the refusal itself, not of the call: the call sites are
 * indistinguishable from one another, while the message says which refusal it is.
 */
const REFUSALS = [
  {
    name: 'a biased advisor task or missing build advice',
    side: 'before',
    marker: 'if (taskGate.refusal) die(taskGate.refusal, 1)',
    why: 'Plan_59 D5/D6: blind choices and design authority must be settled without spending quota',
  },
  {
    name: 'an impossible --scope pattern',
    side: 'before',
    marker: '`--scope pattern ${JSON.stringify(scopeRefusal.pattern)} refused',
    why: 'Plan_27: nothing has been touched and the order has to be rewritten',
  },
  {
    name: 'a detached tree left by an abandoned run',
    side: 'before',
    marker: 'repository is detached after abandoned run',
    why: 'the repository has to be returned to its branch first, by the operator',
  },
  {
    name: 'a refused continuation',
    side: 'before',
    marker: 'if (continuationError) die(continuationError)',
    why: 'the chain, not the tree, is what refuses; no folder may join the chain',
  },
  {
    name: 'a repeat that needs --continue',
    side: 'before',
    marker: '`--continue is required:',
    why: 'Plan_23: a folder here sent the next identical order to the continuation gate',
  },
  {
    name: 'a dead host sandbox',
    side: 'before',
    marker: 'die(sandboxRefusal(sandboxProbe))',
    why: 'Plan_57: the host is broken, the order is not; repair precedes any run',
  },
  {
    name: 'a busy tree or an unavailable Codex CLI',
    side: 'before',
    marker: 'if (preflightError) die(preflightError, 1)',
    why: 'Plan_58: both spend no quota, so neither may leave a path in the worktree',
  },
  {
    name: 'an argument cmd.exe cannot carry',
    side: 'after',
    marker: 'argument cannot be passed through cmd.exe',
    why: 'the tree snapshot is already inside the folder, so the folder explains itself',
  },
  {
    name: 'a worker that failed to spawn',
    side: 'after',
    marker: 'run worker process failed to start',
    why: 'the worker order is already written; a half-started run must be readable later',
  },
];

const registrationIndex = LAUNCHER.indexOf('= makeRunDir(');

test('the launcher registers a run exactly once', () => {
  assert.notEqual(registrationIndex, -1);
  assert.equal(LAUNCHER.split('= makeRunDir(').length - 1, 1);
});

test('task gates precede the paid sandbox probe and read the one parsed task', () => {
  // Plan_59 D5/D6: a biased advisor task or a build order without advice costs nothing. The task
  // text comes from parseArgs alone; a second argv reader would drift from it.
  const taskGate = LAUNCHER.indexOf('if (taskGate.refusal) die(taskGate.refusal, 1)');
  assert.ok(taskGate > LAUNCHER.indexOf('= parseArgs(argv)'));
  assert.ok(taskGate >= 0 && taskGate < LAUNCHER.indexOf('await probeSandbox('));
  assert.equal(LAUNCHER.includes('preflightAdvisorInput'), false);
});

for (const { name, side, marker, why } of REFUSALS) {
  test(`${name} refuses ${side} registration: ${why}`, () => {
    const at = LAUNCHER.indexOf(marker);
    assert.notEqual(at, -1, `refusal marker no longer present: ${marker}`);
    assert.equal(LAUNCHER.indexOf(marker, at + 1), -1, `refusal marker is not unique: ${marker}`);
    if (side === 'before') assert.ok(at < registrationIndex, `${name} now refuses after registration`);
    else assert.ok(at > registrationIndex, `${name} now refuses before registration`);
  });
}

test('every refusal in the launcher is classified by the table', () => {
  const sites = LAUNCHER.match(/\bdie\(|\bwriteFailure\(/g) || [];
  assert.equal(
    sites.length,
    REFUSALS.length,
    'a refusal was added or removed without a row above; classify it and say why that side',
  );
});

/**
 * The structural half of the rule, and the reason the pre-flight checks were moved into their own
 * module rather than merely reordered: a check that cannot name a run folder cannot leave one.
 */
test('the pre-flight module cannot write a run folder', () => {
  const preflight = read('preflight.mjs');
  for (const forbidden of ['runDir', 'makeRunDir', 'writeStatus', 'writeFailure', 'status.json']) {
    assert.ok(
      !preflight.includes(forbidden),
      `preflight.mjs mentions ${forbidden}: a pre-flight refusal must not be able to register a run`,
    );
  }
});

test('the CLI availability check no longer records a failure of its own', () => {
  const codexCmd = read('codex-cmd.mjs');
  assert.ok(!codexCmd.includes('writeFailure'), 'codex-cmd.mjs writes a refusal folder again');
  assert.match(codexCmd, /export function codexUnavailableReason\(\) \{/);
});
