/**
 * Defines each delegated agent's role, wall-clock budget, write access and result file.
 * D2: a budget declares positive minutes or named phases; budgets.mjs alone normalizes it.
 *
 * The three agents were listed four times: twice in run-config.mjs for budgets and models,
 * once in codex-args.mjs for role lookup, and once in order-gate.mjs for guarded names.
 * Adding an agent could silently leave one copy behind. Shared data lives here so config
 * and hooks can read one registry without importing reply formatting or creating a cycle.
 */
export const AGENTS = {
  'codex-scout': { role: 'scout', budget: 15, writes: false, result: 'result.json' },
  'codex-build': { role: 'build', budget: 25, writes: true, result: 'result.json' },
  'codex-review': { role: 'review', budget: 20, writes: false, result: 'review.json' },
};

export const agentRole = (agent) => AGENTS[agent]?.role;
