/**
 * Judges startup-context references and unread repository coordinates in scout responses.
 * Plan_60 D1: honest answers about handed context need no command, unlike the 2026-09-16
 * dead sandbox; a marker must never excuse invented addresses or an unsourced answer.
 */
import { QUESTION_KIND } from '../runner/question-kind.mjs';

export function allStartupContext(questions) {
  return Array.isArray(questions) && questions.length > 0
    && questions.every((question) => question?.kind === QUESTION_KIND.STARTUP_CONTEXT);
}

export function contextOnlyGap({ questions, result, commandsExecuted }) {
  const answers = Array.isArray(result?.answers) ? result.answers : [];
  const byId = new Map();
  for (const answer of answers) {
    const id = String(answer?.question_id || '').trim().toUpperCase();
    if (id && !byId.has(id)) byId.set(id, answer);
  }
  const unsourced = (Array.isArray(questions) ? questions : [])
    .filter((question) => question?.kind === QUESTION_KIND.STARTUP_CONTEXT)
    .filter((question) => {
      const answer = byId.get(String(question.id || '').trim().toUpperCase());
      return !Array.isArray(answer?.evidence)
        || !answer.evidence.some((item) => /^startup:\s*\S/.test(String(item ?? '')));
    })
    .map((question) => question.id);
  if (unsourced.length) {
    return `responses to startup-context questions without a startup:<source> reference: ${unsourced.join(', ')}`;
  }
  if (commandsExecuted !== 0) return null;
  const references = answers.flatMap((answer) => Array.isArray(answer?.evidence) ? answer.evidence : []);
  references.push(...(Array.isArray(result?.findings) ? result.findings : []).map((finding) => finding?.where));
  for (const reference of references) {
    const text = String(reference ?? '');
    if (text.startsWith('startup:')) continue;
    const coordinate = text.match(/\S*\.[A-Za-z0-9]+:\d+/)?.[0];
    if (coordinate) {
      return `scout cited ${coordinate.slice(0, 60)} without executing a command: an address nobody read`;
    }
  }
  return null;
}
