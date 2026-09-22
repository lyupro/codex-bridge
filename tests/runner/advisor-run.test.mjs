/** Plan_59 C2/D5/D7: advisor phases must reach plain exec or refuse before spending quota. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { advisorSchema, schemaFor, SCHEMAS } from '../../src/home/lib/runner/schemas.mjs';
import { INSTRUCTIONS } from '../../src/home/lib/runner/prompts.mjs';
import { codexArgs } from '../../src/home/lib/runner/codex-args.mjs';
import { loadRunEnv } from '../../src/home/lib/runner/run-env.mjs';
import { validScope } from '../meta/advisor-fixtures.mjs';
import { parseAdvisorTask } from '../../src/home/lib/meta/advisor-task.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';

function fixture(config = {}) {
  const root = makeTempTree('advisor-run-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const runs = path.join(repo, 'runs');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return { root, repo, home, runs };
}

function launch(tree, { phase, task = TASK, refuse = false, continued = false, taskFile = false } = {}) {
  const args = ['--agent', 'codex-advisor', '--repo', tree.repo, '--order-id', 'advisor-fixture',
    ...(phase === undefined ? [] : ['--phase', phase]), ...(continued ? ['--continue'] : [])];
  if (taskFile) {
    const file = path.join(tree.root, 'task.md');
    fs.writeFileSync(file, task);
    args.push('--task-file', file);
  }
  const source = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: refuse ? 'forbidden' : 'spawn', probe: refuse ? 'forbidden' : 'marker' })}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
try { process.exitCode = await launcher(${JSON.stringify(args)}); }
catch (error) {
  if (typeof error?.exitCode !== 'number') throw error;
  process.exitCode = error.exitCode;
}
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tree.repo, input: taskFile ? '' : task, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: tree.home, CODEX_RUNS_ROOT: tree.runs },
  });
}

function runFrom(output) {
  assert.equal(output.status, 0, output.stderr || output.stdout || output.error?.message);
  const line = output.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, output.stdout);
  const dir = line.slice(4).split(' order-id=')[0];
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  return { dir, schema: read('schema.json'), worker: read('worker.json'), status: read('status.json'),
    advisorTask: read('advisor-task.json'), task: fs.readFileSync(path.join(dir, 'task.md'), 'utf8') };
}

function assertFree(tree, output, code, message) {
  assert.equal(output.status, code, output.stderr || output.error?.message);
  assert.equal(output.stdout, '');
  assert.match(output.stderr, message);
  assert.match(output.stderr, /The run folder was not created; quota was not spent\.\s*$/);
  assert.equal(fs.existsSync(tree.runs), false);
  assert.deepEqual(fs.readdirSync(tree.repo), ['source.mjs']);
}

test('scope writes its phase schema, read-only argv, configured profile and answer language', () => {
  const model = randomUUID();
  const tree = fixture({ models: { advisor: { model, effort: 'high' } }, answerLanguage: 'Spanish' });
  const { dir, schema, worker, status, task } = runFrom(launch(tree, { phase: 'scope', taskFile: true }));
  assert.deepEqual(schema, advisorSchema('scope'));
  assert.equal(worker.phase, 'scope');
  assert.equal(status.phase, 'scope');
  assert.equal(worker.budget_minutes, 5);
  assert.equal(worker.args[0], 'exec');
  assert.equal(worker.args.includes('review'), false);
  assert.equal(worker.args[worker.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(worker.args[worker.args.indexOf('--output-schema') + 1], path.join(dir, 'schema.json'));
  assert.equal(worker.args[worker.args.indexOf('-o') + 1], path.join(dir, 'result.json'));
  assert.equal(worker.args[worker.args.indexOf('-m') + 1], model);
  assert.ok(worker.args.includes('model_reasoning_effort=high'));
  assert.ok(worker.args.includes('--ignore-user-config'));
  assert.ok(worker.args.includes('agents.enabled=false'));
  assert.equal(worker.profile.model_source, 'config');
  assert.equal(worker.profile.effort_source, 'config');
  assert.equal(Object.hasOwn(status, 'advice'), false);
  assert.equal(fs.existsSync(path.join(dir, 'questions.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'scope.txt')), false);
  assert.match(task, /Scope phase:/);
  assert.match(task, /every text field of result\.json in Spanish/);
});

test('advise without --continue refuses before a probe or run folder exists', () => {
  const tree = fixture();
  assertFree(tree, launch(tree, { phase: 'advise', refuse: true }), 2,
    /requires --continue: phase 2 continues the scope run of the same order so it can settle the risks phase 1 predicted/);
});

for (const taskFile of [false, true]) {
  test(`biased advisor task is refused through the launcher (task file=${taskFile})`, () => {
    const tree = fixture();
    const task = TASK.replace('Keep the boundary.', 'Keep the boundary (recommended).');
    assertFree(tree, launch(tree, { phase: 'scope', task, taskFile, refuse: true }), 1, /remove preference marker/);
  });
}

test('advisor requires an explicit phase and refuses undeclared phases for free', () => {
  for (const phase of [undefined, 'default', 'typo']) {
    const tree = fixture();
    assertFree(tree, launch(tree, { phase, refuse: true }), 2,
      phase === undefined ? /--phase is required.*scope, advise/ : /undeclared --phase.*scope, advise/);
  }
});

// Plan_59 D7: keep the phase boundary covered even if an earlier launcher guard regresses.
test('phase resolution requires a continuation only for the advisor decision pass', () => {
  const preflight = new URL('../../src/home/lib/runner/preflight.mjs', import.meta.url).href;
  for (const [agent, phase, continued, exitCode] of [
    ['codex-advisor', 'scope', false, 0], ['codex-advisor', 'advise', true, 0],
    ['codex-advisor', 'advise', false, 2], ['codex-scout', 'advise', false, 0],
  ]) {
    const source = `
import { resolveRunPhase } from ${JSON.stringify(preflight)};
try {
  console.log(resolveRunPhase(${JSON.stringify({ agent, phase, continue: continued })},
    { advisor: { scope: 5, advise: 15 }, scout: { advise: 15 } }));
} catch (error) { if (typeof error?.exitCode !== 'number') throw error; process.exitCode = error.exitCode; }
`;
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(output.status, exitCode, output.stderr || output.error?.message);
    if (exitCode === 0) assert.equal(output.stdout.trim(), phase);
    else assert.match(output.stderr, /requires --continue.*The run folder was not created; quota was not spent/);
  }
});

test('advise continues the scope order with its own schema and budget', () => {
  const tree = fixture();
  const first = runFrom(launch(tree, { phase: 'scope' }));
  fs.writeFileSync(path.join(first.dir, 'status.json'), JSON.stringify({ ...first.status, state: 'finished' }));
  fs.writeFileSync(path.join(first.dir, 'meta.json'), JSON.stringify({ agent: 'codex-advisor', status: 'OK', phase: 'scope' }));
  fs.writeFileSync(path.join(first.dir, 'result.json'), JSON.stringify(validScope()));
  const task = `${TASK}\ncontinue: ${path.basename(first.dir)} — settle the scope predictions\n`;
  const second = runFrom(launch(tree, { phase: 'advise', continued: true, task }));
  assert.notEqual(second.dir, first.dir);
  assert.deepEqual(second.schema, advisorSchema('advise'));
  assert.equal(second.worker.phase, 'advise');
  assert.equal(second.worker.budget_minutes, 15);
  assert.equal(second.status.order_id, first.status.order_id);
  assert.equal(second.status.continued_from, path.basename(first.dir));
  assert.match(second.task, /Advise phase:/);
});

test('launcher saves the exact parsed task given to the advisor', () => {
  const tree = fixture();
  const run = runFrom(launch(tree, { phase: 'scope' }));
  assert.deepEqual(run.advisorTask, parseAdvisorTask(TASK));
});

test('advise refuses for free when the continued run is not an OK scope run', () => {
  const tree = fixture();
  const first = runFrom(launch(tree, { phase: 'scope' }));
  fs.writeFileSync(path.join(first.dir, 'status.json'), JSON.stringify({ ...first.status, state: 'finished' }));
  fs.writeFileSync(path.join(first.dir, 'meta.json'), JSON.stringify({ agent: 'codex-advisor', status: 'OK', phase: 'advise' }));
  fs.writeFileSync(path.join(first.dir, 'result.json'), JSON.stringify(validScope()));
  const task = `${TASK}\ncontinue: ${path.basename(first.dir)} — settle the scope predictions\n`;
  const before = fs.readdirSync(tree.runs);
  const output = launch(tree, { phase: 'advise', continued: true, task, refuse: true });
  assert.equal(output.status, 1, output.stdout || output.error?.message);
  assert.equal(output.stdout, '');
  assert.match(output.stderr, /phase must be 'scope'/);
  assert.match(output.stderr, /The run folder was not created; quota was not spent\.\s*$/);
  assert.deepEqual(fs.readdirSync(tree.runs), before);
});

test('advisor plain exec omits scout-only git bypass in a repository and keeps config defaults', () => {
  loadRunEnv();
  for (const isGitRepo of [true, false]) {
    const args = codexArgs({ agent: 'codex-advisor', repo: '/repo', models: {} }, '/run', isGitRepo);
    assert.equal(args.includes('--skip-git-repo-check'), !isGitRepo);
    assert.equal(args.includes('-m'), false);
    assert.equal(args.includes('--question'), false);
    assert.equal(args.includes('--phase'), false);
  }
});

test('schema lookup requires the advisor phase and preserves every other schema', () => {
  for (const [agent, schema] of Object.entries(SCHEMAS)) assert.equal(schemaFor(agent, 'scope'), schema);
  for (const phase of ['scope', 'advise']) assert.equal(schemaFor('codex-advisor', phase), advisorSchema(phase));
  for (const phase of [undefined, '', 'default']) assert.throws(() => schemaFor('codex-advisor', phase), RangeError);
});

test('both prompt phases preserve the read boundary, independent evidence and language rule', () => {
  for (const phase of ['scope', 'advise']) {
    const prompt = INSTRUCTIONS['codex-advisor']({ phase });
    for (const text of ['DESIGN before code exists', 'ONLY the paths listed under `## Paths`',
      '`git log` / `git show` on those paths', 'Write nothing', 'do not spawn or delegate',
      '`path:line` address inside those paths', 'machine-checked for existence',
      'task carries no preference on purpose', 'agreeing without independent checks',
      'disagreeing to look independent', 'opinion, not advice', 'Agreeing is fine',
      'every text field of result.json in English']) assert.ok(prompt.includes(text), text);
  }
});

test('scope predicts before reading and advise uses each required decision lens', () => {
  const scope = INSTRUCTIONS['codex-advisor']({ phase: 'scope' });
  for (const text of ['BEFORE reading in depth', '3-5 predicted_risks with ids r1..r5',
    'first, then read', 'sufficient', 'missing_paths (concrete repository paths',
    'taken_on_trust', 'never empty']) assert.ok(scope.includes(text), text);
  const advise = INSTRUCTIONS['codex-advisor']({ phase: 'advise' });
  for (const text of ['every predicted risk', 'risk_outcomes', 'confirmed or refuted',
    'ONE recommendation', 'option_id', 'none-of-these', 'unlisted_option', 'rejected with its cost',
    'EVERY', 'strongest_counterargument comes from a skeptic', 'pre_mortem comes from the executor',
    'early_check of kind test | command | inspect', 'inspect requires an address',
    'question_defect comes from the requester', 'VERIFIED (requires an address) | REASONABLE | FRAGILE',
    'open_questions, not why', 'independent_checks']) assert.ok(advise.includes(text), text);
  assert.doesNotMatch(scope, /Advise phase:/);
  assert.doesNotMatch(advise, /Scope phase:/);
  assert.throws(() => INSTRUCTIONS['codex-advisor']({}), RangeError);
});
