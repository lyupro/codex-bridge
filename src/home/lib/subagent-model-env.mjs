/** decides whether the host's subagent-model environment overrides a dispatcher's frontmatter pin
 * Plan_67 D6 (b) and the host documentation facts recorded in its Council (2026-09-25):
 * env moved below frontmatter in 2.1.251; FORCE=1 overrides it starting with 2.1.257.
 * Unknown host versions are not evidence for a pre-start refusal.
 */
import { modelFamily } from './model-family.mjs';
import { orderDiagnosticMessage } from './order-diagnostics.mjs';

// Host contract facts, not package versions or volatile model identifiers (Plan_67 D6 (b)).
export const FRONTMATTER_PRECEDENCE_VERSION = '2.1.251'; // order-guard: not-a-refusal — host version boundary compared as data
export const SUBAGENT_MODEL_FORCE_VERSION = '2.1.257'; // order-guard: not-a-refusal — host version boundary compared as data

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)*$/.test(value)) return null;
  return value.split('.').map(BigInt);
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0n) - (right[index] ?? 0n);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return 0;
}

export function envOverridesPin({ env, hostVersion }) {
  const model = env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (typeof model !== 'string' || model.length === 0) return false;
  const version = versionParts(hostVersion);
  if (version === null) return false;
  return compareVersions(version, versionParts(FRONTMATTER_PRECEDENCE_VERSION)) < 0
    || (env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE === '1'
      && compareVersions(version, versionParts(SUBAGENT_MODEL_FORCE_VERSION)) >= 0);
}

export function envModelProblem({ env, hostVersion, pinFamily }) {
  if (!envOverridesPin({ env, hostVersion })) return null;
  const model = env.CLAUDE_CODE_SUBAGENT_MODEL;
  const family = modelFamily(model);
  if (family === null || pinFamily === null || family === pinFamily) return null;
  return [orderDiagnosticMessage('subagent-model-env-pin', { model, pinFamily, hostVersion }),
    orderDiagnosticMessage('run-not-created')].join(' ');
}
