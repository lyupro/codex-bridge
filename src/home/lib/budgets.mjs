/**
 * Resolves every role's wall-clock budget into a map of phase names to minutes.
 *
 * A run gets a hard wall-clock budget, because the caller's timeout is not a run contract:
 * on 2026-08-03 one order restarted six times and spent 170,293 accounted tokens while four
 * killed callers left their Codex processes and token spend unrecorded. Plan_59 D2 made the
 * phase a runner concept: a number is shorthand for one `default` phase, and it is expanded
 * here and nowhere else, so no consumer ever has to ask which of the two shapes it holds.
 */
import { AGENTS } from './agents.mjs';

export function resolveBudgets(file, overrides = {}, registry = AGENTS) {
  const roles = Object.values(registry).map(({ role }) => role);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`${file}: key “budgets” must be an object keyed by ${roles.join(', ')}, ` +
      `each holding a positive number of minutes or a phase map, not ${JSON.stringify(overrides)}`);
  }
  const normalize = (budget, key, defaults) => {
    if (typeof budget === 'string' && !budget.trim()) {
      throw new Error(`${file}: key “${key}” is empty; remove the field to use the default, ` +
        'or give it a positive number of minutes or a phase map');
    }
    const scalar = typeof budget === 'number';
    // A number for a role with named phases would replace its whole map with `default`: the
    // config would read cleanly and every run of that role would then be refused.
    if (scalar && defaults && Object.keys(defaults).some((phase) => phase !== 'default')) {
      throw new Error(`${file}: key “${key}” must be a phase map for this role, ` +
        `e.g. {${Object.keys(defaults).map((phase) => `"${phase}": ${defaults[phase]}`).join(', ')}}, ` +
        `not ${JSON.stringify(budget)}`);
    }
    if (scalar) budget = { default: budget };
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      throw new Error(`${file}: key “${key}” must be a positive number of minutes or a phase map, ` +
        `not ${JSON.stringify(budget)}`);
    }
    for (const [phase, minutes] of Object.entries(budget)) {
      if (!phase.trim()) throw new Error(`${file}: key “${key}” has an empty phase name`);
      if (defaults && !scalar && !Object.hasOwn(defaults, phase)) {
        throw new Error(`${file}: key “${key}” has unknown phase “${phase}”. ` +
          `Only ${Object.keys(defaults).join(', ')} are allowed`);
      }
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`${file}: key “${key}.${phase}” must be a positive number of minutes, ` +
          `not ${JSON.stringify(minutes)}`);
      }
    }
    // D2: a scalar is a default-only budget; only an object requests a partial phase override.
    return { ...(scalar ? {} : defaults), ...budget };
  };
  const budgets = Object.fromEntries(Object.values(registry).map(({ role, budget }) => {
    const phases = normalize(budget, `budgets.${role}`);
    if (!Object.keys(phases).length) {
      throw new Error(`${file}: key “budgets.${role}” must declare at least one phase`);
    }
    return [role, phases];
  }));
  for (const [role, budget] of Object.entries(overrides)) {
    if (!roles.includes(role)) {
      throw new Error(`${file}: key “budgets” has unknown role “${role}”. Only ${roles.join(', ')} are allowed`);
    }
    budgets[role] = normalize(budget, `budgets.${role}`, budgets[role]);
  }
  return budgets;
}
