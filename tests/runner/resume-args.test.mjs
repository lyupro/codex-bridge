/** Plan_80 E13/O4: resume preserves the failed read-only run's profile and thread. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resumeArgs, runProfile } from '../../src/home/lib/runner/codex-args.mjs';
import { unsafeForCmd } from '../../src/home/lib/runner/codex-cmd.mjs';
import { resumePrompt } from '../../src/home/lib/runner/prompts.mjs';
import { CLEAN_ENV, RUN_ENV, loadRunEnv } from '../../src/home/lib/runner/run-env.mjs';
import { DEFAULTS, disableFlags } from '../../src/home/lib/run-config.mjs';
import { platformSandboxArgs } from '../../src/home/lib/runner/sandbox-flags.mjs';
import { workerOrder } from '../../src/home/lib/runner/worker-order.mjs';

loadRunEnv();

const threadId = '01234567-89AB-CDEF-0123-456789ABCDEF';
const runDir = path.join(os.tmpdir(), 'resume run');
const agents = ['codex-advisor', 'codex-scout', 'codex-review'];

for (const agent of agents) {
  for (const hasModel of [false, true]) {
    for (const hasSpeed of [false, true]) {
      test(`${agent} exact resume argv: model=${hasModel}, speed=${hasSpeed}`, () => {
        const profile = Object.freeze({
          model: hasModel ? randomUUID() : '',
          effort: 'high',
          speed: hasSpeed ? randomUUID() : '',
        });
        const args = resumeArgs({ agent, profile, threadId, runDir, isolationFlags: CLEAN_ENV });
        assert.deepEqual(args, [
          'exec', 'resume', threadId, '--json', ...CLEAN_ENV,
          '--ignore-user-config', '-c', 'model_reasoning_effort=high',
          ...(hasSpeed ? ['-c', `service_tier=${profile.speed}`] : []),
          '-c', 'agents.enabled=false', ...platformSandboxArgs(),
          ...(hasModel ? ['-m', profile.model] : []),
          '-c', 'sandbox_mode=read-only', '--skip-git-repo-check',
          '--output-schema', path.join(runDir, 'schema.json'),
          '-o', path.join(runDir, agent === 'codex-review' ? 'review.json' : 'result.json'),
          '-',
        ]);
        assert.equal(Boolean(unsafeForCmd(args)), false);
        assert.equal(args.includes('-C'), false);
        assert.equal(args.includes('--sandbox'), false);
        assert.equal(args.some((arg) => arg.startsWith('--dangerously-')), false);
      });
    }
  }
}

test('resume uses only the frozen profile even when live and supplied models differ', () => {
  const previousModels = RUN_ENV.models;
  const profile = Object.freeze({ model: randomUUID(), effort: 'high', speed: randomUUID() });
  const liveProfile = { model: randomUUID(), effort: 'low', speed: randomUUID() };
  const suppliedProfile = { model: randomUUID(), effort: 'medium', speed: randomUUID() };
  try {
    RUN_ENV.models = Object.fromEntries(agents.map((agent) => [agent.slice(6), liveProfile]));
    for (const agent of agents) {
      const models = { [agent.slice(6)]: suppliedProfile };
      assert.equal(runProfile({ agent }).model, liveProfile.model);
      assert.equal(runProfile({ agent, models }).model, suppliedProfile.model);
      const args = resumeArgs({ agent, profile, threadId, runDir, isolationFlags: CLEAN_ENV, models, effort: 'low' });
      assert.equal(args[args.indexOf('-m') + 1], profile.model);
      assert.deepEqual(args.filter((arg) => arg.startsWith('model_reasoning_effort=')),
        ['model_reasoning_effort=high']);
      assert.deepEqual(args.filter((arg) => arg.startsWith('service_tier=')),
        [`service_tier=${profile.speed}`]);
      assert.equal(args.includes(liveProfile.model), false);
      assert.equal(args.includes(suppliedProfile.model), false);
      assert.equal(Boolean(unsafeForCmd(args)), false);
      const unpinned = resumeArgs({ agent, profile: { effort: 'high' }, threadId, runDir, isolationFlags: CLEAN_ENV, models });
      assert.equal(unpinned.includes('-m'), false);
      assert.equal(unpinned.some((arg) => arg.startsWith('service_tier=')), false);
      assert.equal(Boolean(unsafeForCmd(unpinned)), false);
    }
  } finally {
    RUN_ENV.models = previousModels;
  }
});

test('resume rejects build and unknown agents', () => {
  for (const agent of ['codex-build', 'codex-unknown']) {
    assert.throws(() => resumeArgs({ agent, profile: { effort: 'high' }, threadId, runDir, isolationFlags: CLEAN_ENV }));
  }
});

test('resume rejects non-UUID thread ids, including spaces and quotes', () => {
  for (const invalid of [undefined, null, 42, '', 'not-a-uuid', `${threadId} `,
    `${threadId}"`, threadId.replace('-', ' ')]) {
    assert.throws(() => resumeArgs({
      agent: 'codex-scout', profile: { effort: 'high' }, threadId: invalid, runDir, isolationFlags: CLEAN_ENV,
    }), TypeError);
  }
});

test('resume requires an object profile with non-empty string effort', () => {
  for (const profile of [undefined, null, 'high', [], {}, { model: randomUUID() },
    { effort: '' }, { effort: '   ' }, { effort: 42 }]) {
    assert.throws(() => resumeArgs({ agent: 'codex-scout', profile, threadId, runDir, isolationFlags: CLEAN_ENV }), TypeError);
  }
});

test('resume requires explicit isolation flags before building arguments', () => {
  const options = { agent: 'codex-scout', profile: { effort: 'high' }, threadId, runDir: null };
  const expected = { name: 'TypeError', message: 'Resume requires explicit isolation flags.' };
  assert.throws(() => resumeArgs(options), expected);
  for (const isolationFlags of [undefined, null, '--disable plugins', {}, 42,
    ['--disable', 42], ['--disable', ''], new Array(1)]) {
    assert.throws(() => resumeArgs({ ...options, isolationFlags }), expected);
  }
});

test('resume accepts empty isolation flags without adding disable switches', () => {
  const args = resumeArgs({
    agent: 'codex-scout', profile: { effort: 'high' }, threadId, runDir, isolationFlags: [],
  });
  assert.equal(args.includes('--disable'), false);
  assert.equal(args[args.indexOf('--json') + 1], '--ignore-user-config');
});

test('resume puts the frozen switch flags immediately after --json without changing them', () => {
  const isolationFlags = Object.freeze(disableFlags({ ...DEFAULTS, hooks: true, plugins: false }));
  const args = resumeArgs({
    agent: 'codex-scout', profile: { effort: 'high' }, threadId, runDir, isolationFlags,
  });
  const start = args.indexOf('--json') + 1;
  assert.deepEqual(args.slice(start, start + isolationFlags.length), isolationFlags);
  const disabled = args.flatMap((arg, index) => arg === '--disable' ? [args[index + 1]] : []);
  assert.ok(disabled.includes('plugins'));
  assert.equal(disabled.includes('hooks'), false);
  assert.equal(args[start + isolationFlags.length], '--ignore-user-config');
});

test('resume works in a fresh worker process without loading the run environment', () => {
  // Plan_80 E17/O5b: a worker has no loaded CLEAN_ENV and must use the parent's frozen flags.
  const isolationFlags = ['--disable', 'plugins'];
  const moduleUrl = new URL('../../src/home/lib/runner/codex-args.mjs', import.meta.url).href;
  const options = { agent: 'codex-scout', profile: { effort: 'high' }, threadId, runDir, isolationFlags };
  const source = `
import { resumeArgs } from ${JSON.stringify(moduleUrl)};
console.log(JSON.stringify(resumeArgs(${JSON.stringify(options)})));
`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(output.status, 0, output.stderr || output.stdout || output.error?.message);
  const args = JSON.parse(output.stdout);
  const start = args.indexOf('--json') + 1;
  assert.deepEqual(args.slice(start, start + isolationFlags.length), isolationFlags);
});

test('worker order records null for a fresh run and the supplied resume object unchanged', () => {
  assert.equal(workerOrder({ agent: 'codex-scout' }).resume, null);
  const resume = Object.freeze({
    thread_id: threadId,
    resumed_from: path.join(os.tmpdir(), 'failed-run'),
    sandbox_mode: 'read-only',
  });
  const order = workerOrder({ agent: 'codex-scout', resume });
  assert.strictEqual(order.resume, resume);
  assert.deepEqual(JSON.parse(JSON.stringify(order)).resume, resume);
});

test('resume prompt is the exact package-owned continuation text, including final newline', () => {
  assert.equal(resumePrompt('silent-stall-candidate'),
    'Your previous turn in this thread stopped before it returned a result (stop situation: silent-stall-candidate).\n' +
    'Continue from what this thread has already read and reasoned. Do not start the task over and do not\n' +
    're-read files whose content you already have, unless one specific fact is missing.\n' +
    "Return the final answer now as JSON that matches this run's output schema, following the rules you\n" +
    'were given at the start of this thread.\n');
});

test('resume prompt substitutes other valid situation kinds', () => {
  for (const kind of ['a', 'deadline', 'transport-break']) {
    assert.equal(resumePrompt(kind), resumePrompt('silent-stall-candidate')
      .replace('silent-stall-candidate', kind));
  }
});

test('resume prompt rejects invalid or missing situation kinds', () => {
  for (const kind of ['', 'Bad Kind', undefined, null, 42, '-stall', 'stall_1']) {
    assert.throws(() => resumePrompt(kind), RangeError);
  }
});
