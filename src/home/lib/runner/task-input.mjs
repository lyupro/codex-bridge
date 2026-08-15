/**
 * Settles the order's task, sub-questions and verification command from the two channels that
 * can carry them, and refuses before a run folder or a paid process can exist.
 *
 * Kept apart from the launcher because it is the one place that has seen both channels: argument
 * parsing runs before the task file has been read, and the file is read without knowing which
 * flags were passed. Deciding it in either of them alone is how a scout order carrying its
 * questions in the file got refused for not passing --question.
 */
import { die, readTaskDocument } from './args.mjs';

export function settleTaskInput(opts) {
  const { task, questions: fileQuestions, verify: fileVerify } = readTaskDocument(opts);
  opts.questions ??= fileQuestions.length ? fileQuestions : undefined;
  opts.verify ??= fileVerify;
  // Still before the run folder exists and before a token of someone else's quota is touched,
  // which is where every refusal of this kind belongs.
  if (opts.agent === 'codex-scout' && !opts.questions?.length) {
    die(
      'a sub-question is required for codex-scout: put one Markdown list item per sub-question ' +
        'under a `Questions` heading in the task file, or repeat --question for manual calls. ' +
        'The runner will not infer questions from the task text; no quota was spent.',
    );
  }
  return task;
}
