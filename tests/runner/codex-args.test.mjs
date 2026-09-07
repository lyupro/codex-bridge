/** Guards requested tier forwarding and provenance; applied tiers are not observable (Plan_56). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { codexArgs, runProfile } from '../../src/home/lib/runner/codex-args.mjs';
import { loadRunEnv } from '../../src/home/lib/runner/run-env.mjs';

loadRunEnv();

for (const role of ['scout', 'build', 'review']) {
  const agent = `codex-${role}`;

  test(`${agent} reports the configured tier alongside model and effort provenance`, () => {
    const configured = { model: randomUUID(), effort: 'high', speed: randomUUID() };
    const models = { [role]: configured };
    assert.deepEqual(runProfile({ agent, models }), {
      model: configured.model, model_source: 'config',
      effort: configured.effort, effort_source: 'config',
      speed: configured.speed, speed_source: 'config',
    });
    const requested = runProfile({ agent, models, effort: 'low', speed: randomUUID() });
    assert.equal(requested.effort, 'low');
    assert.equal(requested.effort_source, 'request');
    assert.equal(requested.speed, configured.speed);
    assert.equal(requested.speed_source, 'config', 'only the configured profile supplies a tier');
  });

  test(`${agent} passes no service_tier override when its tier is not pinned`, () => {
    const otherRole = role === 'build' ? 'scout' : 'build';
    for (const profile of [undefined, { model: randomUUID(), effort: 'high' }]) {
      const opts = { agent, repo: '/repo', models: {
        [role]: profile, [otherRole]: { speed: randomUUID() },
      } };
      const resolved = runProfile(opts);
      assert.equal(resolved.speed, '');
      assert.equal(resolved.speed_source, 'codex default');
      assert.equal(codexArgs(opts, '/run', true).some((arg) => arg.includes('service_tier')), false);
    }
  });

  test(`${agent} requests exactly the pinned identifier beside its reasoning effort`, () => {
    const speed = randomUUID();
    const models = { [role]: { speed, effort: 'high' } };
    const args = codexArgs({ agent, repo: '/repo', models }, '/run', true);
    assert.deepEqual(args.filter((arg) => arg.startsWith('service_tier=')), [`service_tier=${speed}`]);
    const effortIndex = args.indexOf('model_reasoning_effort=high');
    assert.deepEqual(args.slice(effortIndex - 1, effortIndex + 3),
      ['-c', 'model_reasoning_effort=high', '-c', `service_tier=${speed}`]);
    assert.equal(args.includes('--ignore-user-config'), role !== 'build');
    assert.equal(args[args.indexOf('--sandbox') + 1], role === 'build' ? 'workspace-write' : 'read-only');
  });
}
