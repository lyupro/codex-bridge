/**
 * Plan_63 D5 — the one place a test turns an order into a runner invocation;
 * at the channel switch only this file changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ALL_ORDER_LABELS, orderInputName } from '../../src/home/lib/order-schema.mjs';

// The schema also lists grants; D5 represents those separately from the order fields.
const ORDER_LABELS = ALL_ORDER_LABELS.filter((label) => label !== 'continue' && label !== 'retry');

function validateOrder(order) {
  if (order === null || typeof order !== 'object'
      || (Object.getPrototypeOf(order) !== Object.prototype && Object.getPrototypeOf(order) !== null)) {
    throw new TypeError('order must be a plain object');
  }
  for (const label of Object.keys(order)) {
    if (!ORDER_LABELS.includes(label)) throw new Error(`Unknown order input label "${label}"`);
  }
}

export function orderTaskText({ order = {}, grant, advice, questions, verify, task = 'Inspect the repository.' }) {
  validateOrder(order);
  const header = [];
  if (advice !== undefined) header.push(`advice: ${advice}`);
  if (grant !== undefined) {
    if (!['continue', 'retry'].includes(grant.kind) || !grant.run || !grant.reason) {
      throw new Error('grant requires kind continue or retry, run, and reason');
    }
    header.push(`${grant.kind}: ${grant.run} — ${grant.reason}`);
  }
  const sections = [`## Task\n${task}`];
  if (questions !== undefined) sections.push(`## Questions\n${questions.map((question) => `- ${question}`).join('\n')}`);
  if (verify !== undefined) sections.push(`## Verify\n${verify}`);
  return `${header.length ? `${header.join('\n')}\n\n` : ''}${sections.join('\n\n')}\n`;
}

export function orderInvocation({ agent, order = {}, grant, advice, questions, verify, task, dir }) {
  if (typeof agent !== 'string' || !agent) throw new Error('agent is required');
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('dir must be an absolute directory');
  const text = orderTaskText({ order, grant, advice, questions, verify, task });
  const taskFile = path.join(dir, 'task.md');
  const flags = ORDER_LABELS.filter((label) => Object.hasOwn(order, label))
    .flatMap((label) => [orderInputName(label), String(order[label])]);
  if (grant !== undefined) flags.push(orderInputName('continue'));
  fs.writeFileSync(taskFile, text);
  return { argv: ['--agent', agent, '--task-file', taskFile, ...flags], taskFile };
}
