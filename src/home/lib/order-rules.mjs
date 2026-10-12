/**
 * Plan_79 D4 places each rule where the orchestrator writes what it governs:
 * the call line or task file → call.mjs; a header label → header.mjs;
 * a body section → task-document.mjs (all under order-rules/).
 * A file outgrowing the gate splits by the next level of the same place
 * (header → label families), never by number; create call.mjs with its first rule.
 */
import { RULES as HEADER_RULES } from './order-rules/header.mjs';
import { RULES as TASK_DOCUMENT_RULES } from './order-rules/task-document.mjs';

const places = [HEADER_RULES, TASK_DOCUMENT_RULES];
const keys = new Set();
for (const rules of places) {
  for (const key of Object.keys(rules)) {
    if (keys.has(key)) throw new Error(`duplicate order rule key: ${key}`);
    keys.add(key);
  }
}
export const ORDER_RULES = Object.freeze(Object.assign({}, ...places));

export function orderRuleMessage(key, values = {}) {
  if (!Object.hasOwn(ORDER_RULES, key)) throw new Error(`unknown order rule: ${key}`);
  return ORDER_RULES[key].message(values);
}

// Plan_79 D3: callers supply the topic catalogue so installed rules do not depend on the CLI tree.
export function validateOrderRules(rules, topics, diagnostics) {
  for (const [key, entry] of Object.entries(rules)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) {
      throw new Error(`invalid order rule key: ${key}`);
    }
    if (Object.hasOwn(diagnostics, key)) throw new Error(`duplicate order key: ${key}`);
    if (!entry || Object.keys(entry).length !== 3 ||
        !['topic', 'rule', 'message'].every((field) => Object.hasOwn(entry, field))) {
      throw new Error(`invalid order rule entry: ${key}`);
    }
    if (!Object.hasOwn(topics, entry.topic)) throw new Error(`unknown order rule topic: ${key}`);
    if (typeof entry.rule !== 'string' || !entry.rule.trim() || entry.rule.includes('{{')) {
      throw new Error(`invalid order rule text: ${key}`);
    }
    if (typeof entry.message !== 'function') throw new Error(`invalid order rule message: ${key}`);
  }
}
