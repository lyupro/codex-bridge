/**
 * Plan_79 D4 places each rule where the orchestrator writes what it governs:
 * the call line or task file → call.mjs; a grant label (continue, retry,
 * advice) → header-grants.mjs; any other header label → header.mjs;
 * a body section → task-document.mjs (all under order-rules/).
 * A file outgrowing the gate splits by the next level of the same place
 * (header → label families), never by number.
 */
import { RULES as HEADER_RULES } from './order-rules/header.mjs';
import { RULES as HEADER_GRANT_RULES } from './order-rules/header-grants.mjs';
import { RULES as TASK_DOCUMENT_RULES } from './order-rules/task-document.mjs';
import { RULES as CALL_RULES } from './order-rules/call.mjs';
import { recordOrderText, checkOrderTextParameters } from './order-text-record.mjs';

const places = [HEADER_RULES, HEADER_GRANT_RULES, TASK_DOCUMENT_RULES, CALL_RULES];
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
  checkOrderTextParameters('orderRuleMessage', key, values, ORDER_RULES[key].data);
  return recordOrderText(ORDER_RULES[key].message(values));
}

// Plan_79 B3b: adds a location to text built by the registry and owns no rule.
export function orderRefusalAt(location, message) {
  checkOrderTextParameters('orderRefusalAt', null, { location, message }, ['location']);
  return recordOrderText(`${location}: ${message}`);
}

// Plan_79 B3c1: adds a source location to text built by the registry and owns no rule.
export function orderProblemLine({ lineNo, reason, line }) {
  checkOrderTextParameters('orderProblemLine', null, { lineNo, reason, line }, ['lineNo', 'line']);
  return recordOrderText(lineNo === null ? reason : `line ${lineNo}: ${reason}: ${line}`);
}

// Plan_79 B3c2: adds a label name to text built by the registry and owns no rule.
export function orderLabelReason(labelName, reason) {
  checkOrderTextParameters('orderLabelReason', null, { labelName, reason }, ['labelName']);
  return recordOrderText(`${labelName} ${reason}`);
}

// Plan_79 B3c2: renders the label schema owned by order-schema.mjs and owns no rule.
export function orderHeaderHelp(labels) {
  checkOrderTextParameters('orderHeaderHelp', null, { labels }, ['labels']);
  return recordOrderText(labels.map(({ label, example }) => `${label}: ${example}`).join('\n'));
}

// Plan_79 D3: callers supply the topic catalogue so installed rules do not depend on the CLI tree.
export function validateOrderRules(rules, topics, diagnostics) {
  for (const [key, entry] of Object.entries(rules)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) {
      throw new Error(`invalid order rule key: ${key}`);
    }
    if (Object.hasOwn(diagnostics, key)) throw new Error(`duplicate order key: ${key}`);
    if (!entry || Object.keys(entry).length !== 4 ||
        !['topic', 'rule', 'message', 'data'].every((field) => Object.hasOwn(entry, field))) {
      throw new Error(`invalid order rule entry: ${key}`);
    }
    if (!Object.hasOwn(topics, entry.topic)) throw new Error(`unknown order rule topic: ${key}`);
    if (typeof entry.rule !== 'string' || !entry.rule.trim() || entry.rule.includes('{{')) {
      throw new Error(`invalid order rule text: ${key}`);
    }
    if (typeof entry.message !== 'function') throw new Error(`invalid order rule message: ${key}`);
    if (!Array.isArray(entry.data) ||
        ![...entry.data].every((name) => typeof name === 'string' && name.trim()) ||
        new Set(entry.data).size !== entry.data.length) {
      throw new Error(`invalid order rule data: ${key}`);
    }
  }
}
