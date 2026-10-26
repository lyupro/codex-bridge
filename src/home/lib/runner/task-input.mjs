/**
 * Settles the order header, task, sub-questions and verification command from the document,
 * and refuses before a run folder or a paid process can exist.
 *
 * Plan_63 D1/D8: transport arguments carry no order fields; file and stdin share this boundary.
 */
import { die, readTaskDocument } from './args.mjs';
import { questionKindRefusal } from './question-kind.mjs';
import { orderFromHeader, orderInputName, renderOrderProblems } from '../order-schema.mjs';
import { orderOptions } from './order-options.mjs';
import { repositoryRefusal, resolveOrderRepository } from './order-repository.mjs';
import { orderRuleMessage, orderLabelReason } from '../order-rules.mjs';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';

export function settleTaskInput(opts) {
  const { task, header, questions: fileQuestions, verify: fileVerify } = readTaskDocument(opts);
  const { order, problems } = orderFromHeader(opts.agent, header);
  if (problems.length) {
    die(renderOrderProblems(opts.agent, problems));
  }
  const normalized = orderOptions(opts.agent, order);
  if (normalized.problems.length) {
    die(normalized.problems.map(({ label, reason }) => orderLabelReason(orderInputName(label), reason)).join('\n'));
  }
  const repositoryReason = order.has('repository') ? repositoryRefusal(order.get('repository')) : null;
  if (repositoryReason) {
    die(orderRuleMessage('repository-path', {
      context: 'task-input', label: orderInputName('repository'), reason: repositoryReason,
    }));
  }
  const repository = resolveOrderRepository({
    taskFile: opts['task-file'] ?? null,
    label: order.has('repository') ? order.get('repository') : undefined,
  });
  if (!repository.ok) {
    if (repository.violation === 'repository-label-invalid') {
      die(orderRuleMessage('repository-path', {
        context: 'task-input', label: orderInputName('repository'),
        reason: repositoryRefusal(repository.values.label),
      }));
    }
    const violations = {
      'repository-mismatch': 'mismatch',
      'repository-label-required': 'label-required',
      'repository-discovery-failed': 'discovery-failed',
    };
    die(orderRuleMessage('repository-source', {
      ...repository.values, violation: violations[repository.violation],
      context: 'task-input', label: orderInputName('repository'),
    }));
  }
  Object.assign(opts, normalized.options);
  opts.repo = repository.repo;
  opts.continue = Boolean(header.grant);
  opts.questions = fileQuestions.length ? fileQuestions : undefined;
  opts.verify = fileVerify;
  // Still before the run folder exists and before a token of someone else's quota is touched,
  // which is where every refusal of this kind belongs.
  if (opts.agent === 'codex-scout' && header.grant?.kind !== 'resume' && !opts.questions?.length) {
    die(orderRuleMessage('scout-questions', { violation: 'missing' }));
  }
  if (opts.agent === 'codex-scout' && header.grant?.kind !== 'resume') {
    const refusal = questionKindRefusal(opts.questions);
    if (refusal) {
      die(orderRuleMessage('question-context-marker', { context: 'task-input', refusal }));
    }
  }
  if (opts.noWait && opts.continue) {
    die(orderDiagnosticMessage('no-wait-grant-conflict', { grant: orderInputName(header.grant.kind) }));
  }
  return { task, header };
}
