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
const PASS_GATE = read('pass-gate.mjs');

/**
 * `marker` is a fragment of the refusal itself, not of the call: the call sites are
 * indistinguishable from one another, while the message says which refusal it is.
 */
const REFUSALS = [
  {
    name: 'a busy order claim',
    side: 'before',
    marker: 'die(orderClaimBusyText(opts.orderId, claim.holder), EXIT.FAIL)',
    why: 'Plan_60 D4c: contention must refuse for free rather than launch a second paid run',
  },
  {
    name: 'another same-order launch registered without a kernel claim',
    side: 'before',
    marker: 'if (text) die(text, EXIT.FAIL)',
    why: 'Plan_60 D4: unsupported platforms re-read immediately before registration to avoid double billing',
  },
  {
    name: 'a biased advisor task or missing build advice',
    side: 'before',
    marker: 'if (taskGate.refusal) die(taskGate.refusal, EXIT.FAIL)',
    why: 'Plan_59 D5/D6: blind choices and design authority must be settled without spending quota',
  },
  {
    name: 'an impossible --scope pattern',
    side: 'before',
    marker: '`${scopeRefusal.flag} pattern ${JSON.stringify(scopeRefusal.pattern)} refused: `',
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
    file: 'pass-gate.mjs',
    marker: 'if (continuationError) die(continuationError)',
    why: 'the chain, not the tree, is what refuses; no folder may join the chain',
  },
  {
    name: 'an advisor scope continuation that would spend the advise pass',
    side: 'before',
    file: 'pass-gate.mjs',
    marker: 'codex-advisor --phase scope refuses --continue',
    why: 'OW-040: failed scope repeats only with retry, preserving the advise continuation',
  },
  {
    name: 'a refused retry',
    side: 'before',
    file: 'pass-gate.mjs',
    marker: 'if (retryError) die(retryError)',
    why: 'Plan_75 D1: a same-pass retry needs a finished failed run of its own order',
  },
  {
    name: 'a retry that changes the failed run agent or phase',
    side: 'before',
    file: 'pass-gate.mjs',
    marker: "a retry repeats the named run's own agent and phase:",
    why: 'Plan_75 D4: a retry repeats the named pass rather than starting another one',
  },
  {
    name: 'a continuation that is not an OK advisor scope run',
    side: 'before',
    file: 'pass-gate.mjs',
    marker: 'scopeRunRefusal({ agent: opts.agent',
    why: 'Plan_59 D14: phase 2 needs a successful phase 1 and must refuse before registration',
  },
  {
    name: 'a repeat that needs --continue',
    side: 'before',
    file: 'pass-gate.mjs',
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
    name: 'a busy tree',
    side: 'before',
    marker: 'if (preflightError) die(preflightError, EXIT.FAIL)',
    why: 'Plan_58: it spends no quota, so it may not leave a path in the worktree',
  },
  {
    name: 'an unclear Codex availability probe',
    side: 'before',
    marker: 'if (availability) die(availability.text, EXIT.FAIL)',
    why: 'Plan_60 D2: an inconclusive probe is an ordinary refusal and spends no quota',
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
const passGateIndex = LAUNCHER.indexOf('await passGate(');

test('the launcher registers a run exactly once', () => {
  assert.notEqual(registrationIndex, -1);
  assert.equal(LAUNCHER.split('= makeRunDir(').length - 1, 1);
});

test('task gates precede the paid sandbox probe and read the one parsed task', () => {
  // Plan_59 D5/D6: a biased advisor task or a build order without advice costs nothing. The task
  // text comes from parseArgs alone; a second argv reader would drift from it.
  const taskGate = LAUNCHER.indexOf('if (taskGate.refusal) die(taskGate.refusal, EXIT.FAIL)');
  assert.ok(taskGate > LAUNCHER.indexOf('= parseArgs(argv)'));
  assert.ok(taskGate >= 0 && taskGate < LAUNCHER.indexOf('await probeSandbox('));
  assert.equal(LAUNCHER.includes('preflightAdvisorInput'), false);
});

test('Codex availability is checked after the repeat refusal and before the paid sandbox probe', () => {
  const availability = LAUNCHER.indexOf('if (availability) die(availability.text, EXIT.FAIL)');
  assert.notEqual(passGateIndex, -1);
  assert.ok(availability > passGateIndex);
  assert.ok(availability < LAUNCHER.indexOf('await probeSandbox('));
});

for (const { name, side, marker, why, file } of REFUSALS) {
  test(`${name} refuses ${side} registration: ${why}`, () => {
    const source = file === 'pass-gate.mjs' ? PASS_GATE : LAUNCHER;
    const markerIndex = source.indexOf(marker);
    assert.notEqual(markerIndex, -1, `refusal marker no longer present: ${marker}`);
    assert.equal(source.indexOf(marker, markerIndex + 1), -1, `refusal marker is not unique: ${marker}`);
    const at = file === 'pass-gate.mjs' ? passGateIndex : markerIndex;
    assert.notEqual(at, -1, 'pass gate call no longer present in the launcher');
    if (side === 'before') assert.ok(at < registrationIndex, `${name} now refuses after registration`);
    else assert.ok(at > registrationIndex, `${name} now refuses before registration`);
  });
}

test('every refusal in the launcher is classified by the table', () => {
  const sites = `${LAUNCHER}\n${PASS_GATE}`.match(/\bdie\(|\bwriteFailure\(/g) || [];
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

test('the pass gate module cannot write a run folder', () => {
  // Plan_75 P0: moving the gate must preserve Plan_58's refusal-before-registration boundary.
  for (const forbidden of ['makeRunDir', 'writeStatus', 'writeFailure', 'mkdirSync', 'writeFileSync']) {
    assert.ok(
      !PASS_GATE.includes(forbidden),
      `pass-gate.mjs mentions ${forbidden}: a pass gate must not be able to register a run`,
    );
  }
});

test('the CLI availability check no longer records a failure of its own', () => {
  const codexCmd = read('codex-cmd.mjs');
  assert.ok(!codexCmd.includes('writeFailure'), 'codex-cmd.mjs writes a refusal folder again');
  assert.ok(!codexCmd.includes(['codex', 'UnavailableReason'].join('')),
    'codex-cmd.mjs restores the retired availability check');
  assert.match(read('codex-availability.mjs'), /export async function probeCodexAvailability\(/);
});
