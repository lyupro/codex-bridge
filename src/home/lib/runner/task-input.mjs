/**
 * Settles the order header, task, sub-questions and verification command from the document,
 * and refuses before a run folder or a paid process can exist.
 *
 * Plan_63 D1/D8: transport arguments carry no order fields; file and stdin share this boundary.
 */
import { die, readTaskDocument } from './args.mjs';
import { questionKindRefusal } from './question-kind.mjs';
import { orderFromHeader, orderInputName, renderOrderHeaderHelp } from '../order-schema.mjs';
import { orderOptions } from './order-options.mjs';

export function settleTaskInput(opts, { cwd = process.cwd() } = {}) {
  const { task, header, questions: fileQuestions, verify: fileVerify } = readTaskDocument(opts);
  const { order, problems } = orderFromHeader(opts.agent, header);
  if (problems.length) {
    die([...problems.map(({ lineNo, line, reason }) => lineNo === null
      ? reason : `line ${lineNo}: ${reason}: ${line}`), renderOrderHeaderHelp(opts.agent)].join('\n'));
  }
  const normalized = orderOptions(opts.agent, order, { cwd });
  if (normalized.problems.length) {
    die(normalized.problems.map(({ label, reason }) => `${orderInputName(label)} ${reason}`).join('\n'));
  }
  Object.assign(opts, normalized.options);
  opts.continue = Boolean(header.grant);
  opts.questions = fileQuestions.length ? fileQuestions : undefined;
  opts.verify = fileVerify;
  // Still before the run folder exists and before a token of someone else's quota is touched,
  // which is where every refusal of this kind belongs.
  if (opts.agent === 'codex-scout' && !opts.questions?.length) {
    die(
      'a sub-question is required for codex-scout: put one Markdown list item per sub-question ' +
        'under a `Questions` heading in the task document. ' +
        'The runner will not infer questions from the task text; no quota was spent.',
    );
  }
  if (opts.agent === 'codex-scout') {
    const refusal = questionKindRefusal(opts.questions);
    if (refusal) {
      die(
        `${refusal}; the marker is exactly [context-only] followed by a space and the question; no quota was spent.`,
      );
    }
  }
  if (opts.noWait && opts.continue) {
    die(`--no-wait cannot be combined with a ${orderInputName(header.grant.kind)} grant: ` +
      'checking an existing run must never authorize a new one.');
  }
  return { task, header };
}
