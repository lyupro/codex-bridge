/** OW-068 / Plan_80 E21: rules a filled answer must satisfy after the run, distinct from order-rules for a task file before the run. */
import { RULES as ADVISOR_RULES } from './answer-rules/advisor.mjs';
import { RULES as BUILD_RULES } from './answer-rules/build.mjs';
import { RULES as SCOUT_RULES } from './answer-rules/scout.mjs';
import { QUESTION_KIND } from './runner/question-kind.mjs';

export const ANSWER_RULES = Object.freeze({ 'codex-advisor': ADVISOR_RULES, 'codex-scout': SCOUT_RULES, 'codex-build': BUILD_RULES });
// The phases each judged agent runs in; an agent added to ANSWER_RULES without a row here is refused at load.
const AGENT_PHASES = Object.freeze({
  'codex-advisor': Object.freeze(['scope', 'advise']),
  'codex-scout': Object.freeze(['default']),
  'codex-build': Object.freeze(['default']),
});
// When an entry is stated: 'always', or only when the order carries a question about handed startup context
// (Plan_60 D1 keeps startup instructions out of every other scout prompt).
const WHEN = Object.freeze({
  always: () => true,
  'startup-context': ({ questions }) => questions.some((question) => question?.kind === QUESTION_KIND.STARTUP_CONTEXT),
});

export function validateAnswerRules(rules, agentPhases = AGENT_PHASES) {
  const keys = new Set();
  for (const [agent, entries] of Object.entries(rules)) {
    if (!Object.hasOwn(agentPhases, agent)) throw new Error(`unknown answer rule agent: ${agent}`);
    const phases = agentPhases[agent];
    for (const [key, entry] of Object.entries(entries)) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) {
        throw new Error(`invalid answer rule key: ${key}`);
      }
      if (keys.has(key)) throw new Error(`duplicate answer rule key: ${key}`);
      keys.add(key);
      if (!entry || Object.keys(entry).length !== 5 ||
          !['phases', 'when', 'rule', 'message', 'data'].every((field) => Object.hasOwn(entry, field))) {
        throw new Error(`invalid answer rule entry: ${key}`);
      }
      if (!Array.isArray(entry.phases) || !entry.phases.length ||
          !entry.phases.every((phase) => phases.includes(phase))) {
        throw new Error(`unknown answer rule phase: ${key}`);
      }
      if (!Object.hasOwn(WHEN, entry.when)) throw new Error(`unknown answer rule condition: ${key}`);
      if (typeof entry.rule !== 'string' || !entry.rule.trim() || entry.rule.includes('{{')) {
        throw new Error(`invalid answer rule text: ${key}`);
      }
      if (typeof entry.message !== 'function') throw new Error(`invalid answer rule message: ${key}`);
      if (!Array.isArray(entry.data) ||
          !entry.data.every((name) => typeof name === 'string' && name.trim()) ||
          new Set(entry.data).size !== entry.data.length) {
        throw new Error(`invalid answer rule data: ${key}`);
      }
    }
  }
}

function agentRules(agent) {
  if (!Object.hasOwn(ANSWER_RULES, agent)) throw new Error(`unknown answer rule agent: ${agent}`);
  return ANSWER_RULES[agent];
}

export function answerRuleMessage(agent, key, values = {}) {
  const rules = agentRules(agent);
  if (!Object.hasOwn(rules, key)) throw new Error(`unknown answer rule: ${key}`);
  const entry = rules[key];
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).length !== entry.data.length ||
      !entry.data.every((name) => Object.hasOwn(values, name))) {
    throw new Error(`invalid answer rule values: ${key}; expected ${entry.data.join(', ')}`);
  }
  return entry.message(values);
}

export function answerRuleStatements(agent, phase, { questions = [] } = {}) {
  const context = { questions: Array.isArray(questions) ? questions : [] };
  return Object.values(agentRules(agent))
    .filter((entry) => entry.phases.includes(phase) && WHEN[entry.when](context)).map((entry) => entry.rule);
}

validateAnswerRules(ANSWER_RULES);
