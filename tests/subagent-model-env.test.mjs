/** Plan_67 D6 (b): refuse only environment overrides supported by known host contracts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  envOverridesPin, envModelProblem, FRONTMATTER_PRECEDENCE_VERSION, SUBAGENT_MODEL_FORCE_VERSION,
} from '../src/home/lib/subagent-model-env.mjs';

const modelEnv = (force) => ({
  CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: force,
});

test('host contract thresholds are exported and compared numerically on both sides', () => {
  assert.equal(FRONTMATTER_PRECEDENCE_VERSION, '2.1.251');
  assert.equal(SUBAGENT_MODEL_FORCE_VERSION, '2.1.257');
  for (const [hostVersion, force, expected] of [
    ['2.1.250', undefined, true], ['2.1.251', undefined, false], ['2.1.252', undefined, false],
    ['2.1.256', '1', false], ['2.1.257', '1', true], ['2.1.258', '1', true],
    ['2.1.9', undefined, true], ['2.1.1000', undefined, false],
    ['2.0.999', undefined, true], ['2.2.0', '1', true], ['3.0.0', undefined, false],
    ['2.1.257.0', '1', true], ['02.01.0257', '1', true],
  ]) {
    assert.equal(envOverridesPin({ env: modelEnv(force), hostVersion }), expected, `${hostVersion}/${force}`);
  }
});

test('FORCE must be exactly the string 1 on a host supporting it', () => {
  for (const force of [undefined, '', '0', 'true', ' 1', '1 ', 1, true]) {
    assert.equal(envOverridesPin({ env: modelEnv(force), hostVersion: '2.1.257' }), false);
    assert.equal(envOverridesPin({ env: modelEnv(force), hostVersion: '2.1.250' }), true);
  }
});

test('absent, empty and non-string env models cannot override a pin', () => {
  for (const model of [undefined, null, '', 1, {}, []]) {
    assert.equal(envOverridesPin({
      env: { CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
      hostVersion: '2.1.257',
    }), false);
  }
  assert.equal(envOverridesPin({
    env: { CLAUDE_CODE_SUBAGENT_MODEL: '  ' }, hostVersion: '2.1.250',
  }), true, 'a non-empty value overrides even if its family cannot be parsed');
});

test('unknown and unparseable host versions never establish an override', () => {
  for (const hostVersion of [undefined, null, '', 'unknown', '2.1', 'v2.1.250', '2.1.250-beta',
    '2.1.250garbage', ' 2.1.250', '2.1.-1', '2..250', 2, {}]) {
    assert.equal(envOverridesPin({ env: modelEnv('1'), hostVersion }), false);
    assert.equal(envModelProblem({ env: modelEnv('1'), hostVersion, pinFamily: 'haiku' }), null);
  }
});

test('a refusal names the env value, pin, host and remedy only for different parsed families', () => {
  const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5-5' };
  const problem = envModelProblem({ env, hostVersion: '2.1.250', pinFamily: 'haiku' });
  assert.match(problem, /CLAUDE_CODE_SUBAGENT_MODEL="claude-opus-5-5"/);
  assert.match(problem, /pin haiku on host 2\.1\.250/);
  assert.match(problem, /Unset CLAUDE_CODE_SUBAGENT_MODEL or set it to the pinned family haiku/);
  assert.equal(envModelProblem({ env, hostVersion: '2.1.250', pinFamily: 'opus' }), null);
  assert.equal(envModelProblem({ env, hostVersion: '2.1.250', pinFamily: null }), null);
  assert.equal(envModelProblem({ env, hostVersion: '2.1.251', pinFamily: 'haiku' }), null);
  assert.ok(envModelProblem({ env: modelEnv('1'), hostVersion: '2.1.257', pinFamily: 'haiku' }));
  for (const model of ['inherit', 'default', 'opusplan', '123', 'provider/unknown', '  ']) {
    assert.equal(envModelProblem({
      env: { CLAUDE_CODE_SUBAGENT_MODEL: model }, hostVersion: '2.1.250', pinFamily: 'haiku',
    }), null, model);
  }
});
