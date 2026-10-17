/** Plan_80 E13 O6: resumes launch from frozen artifacts instead of today's task and profile. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation } from './order-invocation.mjs';
import { validScope } from '../meta/advisor-fixtures.mjs';
import { resumePrompt } from '../../src/home/lib/runner/prompts.mjs';
import { advisorSchema } from '../../src/home/lib/runner/schemas.mjs';
import { disableFlags } from '../../src/home/lib/run-config.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const TASK_INPUT = new URL('../../src/home/lib/runner/task-input.mjs', import.meta.url).href;
const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';
const KIND = 'silent-stall-candidate';
const NOTE = 'Finish the stopped pass \u2014 caf\u00e9 and \u65e5\u672c\u8a9e.  \nKeep this note for the record.';

function fixture() {
  const root = makeTempTree('resume-launch-run-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [repo, home, codexHome]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    models: { advisor: { model: randomUUID(), effort: 'high' } },
  }));
  return { root, repo, home, codexHome, runs: path.join(repo, 'runs') };
}

function launch(tree, phase, grant) {
  const { argv } = orderInvocation({
    agent: 'codex-advisor', order: { repository: tree.repo, 'order id': 'resume-launch', phase },
    grant: grant ? { ...grant, kind: grant.kind === 'resume' ? 'continue' : grant.kind } : undefined,
    task: grant?.kind === 'resume' ? NOTE : TASK, dir: tree.root,
  });
  // O8 enables the public label later; inject only the parsed grant, keeping the real input boundary.
  const inputWrapper = `
import { settleTaskInput as original } from ${JSON.stringify(TASK_INPUT)};
export function settleTaskInput(opts) {
  const result = original(opts);
  result.header.grant = ${JSON.stringify(grant)};
  return result;
}`;
  const source = `
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: 'spawn', probe: 'marker' })}
const mockedSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.includes('--worker') && options.cwd !== ${JSON.stringify(tree.repo)}) {
    throw new Error('The worker must start in the repository');
  }
  return mockedSpawn(command, args, options);
};
syncBuiltinESMExports();
if (${JSON.stringify(grant?.kind === 'resume')}) registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './task-input.mjs' && context.parentURL === ${JSON.stringify(LAUNCHER)}) {
      return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(inputWrapper)}), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
try { process.exitCode = await launcher(${JSON.stringify(argv)}); }
catch (error) {
  if (typeof error?.exitCode !== 'number') throw error;
  process.exitCode = error.exitCode;
}
`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tree.repo, input: '', encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: tree.home, CODEX_RUNS_ROOT: tree.runs, CODEX_HOME: tree.codexHome },
  });
  assert.equal(output.status, 0, output.stderr || output.stdout || output.error?.message);
  const line = output.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, output.stdout);
  const dir = line.slice(4).split(' order-id=')[0];
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  return { dir, read, status: JSON.parse(read('status.json')), worker: JSON.parse(read('worker.json')) };
}

function finish(run, status, extra = {}) {
  fs.writeFileSync(path.join(run.dir, 'status.json'), JSON.stringify({ ...run.status, state: 'finished', ...extra }));
  fs.writeFileSync(path.join(run.dir, 'meta.json'), JSON.stringify({
    agent: 'codex-advisor', phase: run.worker.phase, status,
  }));
}

function failedThread(tree, run, thread) {
  const startedAt = run.status.started_at;
  const stoppedAt = new Date().toISOString();
  finish(run, 'FAIL');
  fs.writeFileSync(path.join(run.dir, 'meta.json'), JSON.stringify({
    agent: 'codex-advisor', phase: 'advise', status: 'FAIL', result_ok: false, session_id: thread,
    situation: { kind: KIND },
    stop: { trigger: 'deadline', tree_stop: { state: 'stopped' },
      session: { state: 'observed', last_record_at: stoppedAt } },
  }));
  fs.writeFileSync(path.join(run.dir, 'events.jsonl'), `${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n`);
  const day = new Date(startedAt);
  const folder = path.join(tree.codexHome, 'sessions', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `rollout-${startedAt.slice(0, 19).replaceAll(':', '-')}-${thread}.jsonl`),
    `${JSON.stringify({ timestamp: stoppedAt, ordinal: 1, type: 'session_meta', payload: { id: thread } })}\n`);
}

function adviseFixture() {
  const tree = fixture();
  const scope = launch(tree, 'scope');
  finish(scope, 'OK');
  fs.writeFileSync(path.join(scope.dir, 'result.json'), JSON.stringify(validScope()));
  const advise = launch(tree, 'advise', {
    kind: 'continue', run: path.basename(scope.dir), reason: 'settle the predicted risks',
  });
  return { tree, scope, advise };
}

test('advise resume launches frozen bytes, profile, repository cwd and the full phase budget', () => {
  const { tree, scope, advise } = adviseFixture();
  const thread = randomUUID();
  failedThread(tree, advise, thread);
  // E13 forbids rebuilding the stopped pass from a changed scope result or today's profile.
  fs.writeFileSync(path.join(scope.dir, 'result.json'), '{"changed":true}\n');
  fs.writeFileSync(path.join(tree.home, 'config.json'), JSON.stringify({
    models: { advisor: { model: randomUUID(), effort: 'low' } },
  }));
  const resumed = launch(tree, 'advise', {
    kind: 'resume', run: path.basename(advise.dir), reason: 'finish the stopped pass',
  });
  assert.notEqual(resumed.dir, advise.dir);
  assert.equal(resumed.status.resumed_from, path.basename(advise.dir));
  assert.equal(resumed.status.continued_from, path.basename(scope.dir));
  assert.equal(Object.hasOwn(resumed.status, 'retry_of'), false);
  for (const [destination, original] of [
    ['task-original.md', 'task.md'], ['schema.json', 'schema.json'], ['advisor-task.json', 'advisor-task.json'],
  ]) assert.deepEqual(fs.readFileSync(path.join(resumed.dir, destination)), fs.readFileSync(path.join(advise.dir, original)));
  assert.deepEqual(fs.readFileSync(path.join(resumed.dir, 'resume-note.md')), Buffer.from(NOTE, 'utf8'));
  assert.equal(resumed.read('task.md'), resumePrompt(KIND));
  assert.equal(resumed.read('task.md').includes(NOTE), false);
  assert.deepEqual(resumed.worker.args.slice(0, 3), ['exec', 'resume', thread]);
  const isolationFlags = disableFlags(JSON.parse(resumed.read('env.json')));
  const isolationStart = resumed.worker.args.indexOf('--json') + 1;
  assert.ok(isolationFlags.length > 0);
  assert.deepEqual(resumed.worker.args.slice(isolationStart, isolationStart + isolationFlags.length), isolationFlags);
  assert.equal(resumed.worker.args[isolationStart + isolationFlags.length], '--ignore-user-config');
  for (const flag of ['--sandbox', '-C']) assert.equal(resumed.worker.args.includes(flag), false);
  const sandbox = resumed.worker.args.indexOf('sandbox_mode=read-only');
  assert.ok(sandbox > 0);
  assert.equal(resumed.worker.args[sandbox - 1], '-c');
  assert.equal(resumed.worker.args[resumed.worker.args.indexOf('--output-schema') + 1], path.join(resumed.dir, 'schema.json'));
  assert.equal(resumed.worker.args[resumed.worker.args.indexOf('-o') + 1], path.join(resumed.dir, 'result.json'));
  assert.deepEqual(resumed.worker.resume, {
    thread_id: thread, resumed_from: path.basename(advise.dir), sandbox_mode: 'read-only',
  });
  assert.deepEqual(resumed.worker.profile, advise.worker.profile);
  assert.equal(resumed.worker.args[resumed.worker.args.indexOf('-m') + 1], advise.worker.profile.model);
  assert.ok(resumed.worker.args.includes(`model_reasoning_effort=${advise.worker.profile.effort}`));
  assert.equal(resumed.worker.budget_minutes, 25);
  assert.deepEqual(resumed.worker.silence_policy, advise.worker.silence_policy);
  assert.equal(JSON.parse(resumed.read('env.json')).models.advisor.effort, 'low');
  assert.equal(resumed.worker.repo, tree.repo);
  for (const name of ['questions.json', 'scope.txt']) assert.equal(fs.existsSync(path.join(resumed.dir, name)), false);
});

test('fresh advisor advise retains its normal task, schema and null resume order', () => {
  const { scope, advise, tree } = adviseFixture();
  assert.equal(scope.worker.resume, null);
  assert.equal(advise.worker.resume, null);
  assert.equal(Object.hasOwn(advise.status, 'resumed_from'), false);
  assert.match(advise.read('task.md'), /## Operator task \(verbatim\)/);
  assert.match(advise.read('task.md'), /Advise phase:/);
  assert.match(advise.read('task.md'), /## Scope phase results[\s\S]*- r1:/);
  assert.deepEqual(JSON.parse(advise.read('schema.json')), advisorSchema('advise'));
  assert.equal(advise.worker.args[0], 'exec');
  assert.equal(advise.worker.args.includes('resume'), false);
  assert.equal(advise.worker.args[advise.worker.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(advise.worker.args[advise.worker.args.indexOf('-C') + 1], tree.repo);
  assert.equal(fs.existsSync(path.join(advise.dir, 'task-original.md')), false);
  assert.equal(fs.existsSync(path.join(advise.dir, 'resume-note.md')), false);
});
