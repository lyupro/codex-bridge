/**
 * Settles the order header, task, sub-questions and verification command from the document,
 * and refuses before a run folder or a paid process can exist.
 *
 * Plan_63 D1/D8: transport arguments carry no order fields; file and stdin share this boundary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { die, readTaskDocument } from './args.mjs';
import { questionKindRefusal } from './question-kind.mjs';
import { orderFromHeader, orderInputName, renderOrderProblems } from '../order-schema.mjs';
import { orderOptions } from './order-options.mjs';

/**
 * OW-061: outside git the launcher keeps `repository:` as given and the project folder takes its
 * last segment, so a dispatcher that folded its own instructions into the value left run folders
 * named `Obsidian. Run the scope phase. Return ≤5 lines and the run folder path.` and
 * `tradeforge.loc (do not cd into codex-runs).` — names with a trailing dot that Windows cannot
 * open through an ordinary path. Only an existing absolute directory whose segments Windows keeps
 * verbatim may name the repository.
 */
export function repositoryRefusal(value) {
  if (!path.isAbsolute(value)) {
    return `must be an absolute path to the repository; got ${JSON.stringify(value)}.`;
  }
  const altered = value.split(/[\\/]/).find((segment) => /[. ]$/.test(segment) && segment !== '.' && segment !== '..');
  if (altered !== undefined) {
    return `has a path segment ending in a dot or a space (${JSON.stringify(altered)}), which Windows strips; ` +
      `got ${JSON.stringify(value)}.`;
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(value).isDirectory();
  } catch {}
  return isDirectory ? null : `must name an existing directory; ${JSON.stringify(value)} is not one.`;
}

export function settleTaskInput(opts, { cwd = process.cwd() } = {}) {
  const { task, header, questions: fileQuestions, verify: fileVerify } = readTaskDocument(opts);
  const { order, problems } = orderFromHeader(opts.agent, header);
  if (problems.length) {
    die(renderOrderProblems(opts.agent, problems));
  }
  const normalized = orderOptions(opts.agent, order, { cwd });
  if (normalized.problems.length) {
    die(normalized.problems.map(({ label, reason }) => `${orderInputName(label)} ${reason}`).join('\n'));
  }
  const repositoryReason = order.has('repository') ? repositoryRefusal(order.get('repository')) : null;
  if (repositoryReason) {
    die(`${orderInputName('repository')} ${repositoryReason}\nThe run folder was not created; quota was not spent.`);
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
