/**
 * Classifies orderer-marked scout questions and refuses malformed markers before quota is spent.
 * Plan_60 D1: only the orderer knows whether a question concerns handed startup context or code;
 * the scout cannot choose its own kind, and startup context currently fails without a command.
 */
export const CONTEXT_ONLY_MARKER = '[context-only]';
export const QUESTION_KIND = Object.freeze({
  STARTUP_CONTEXT: 'startup-context',
  CODE_REQUIRED: 'code-required',
});

export function questionKindRefusal(texts = []) {
  for (const [index, text] of texts.entries()) {
    const tokens = text.matchAll(/\[\s*context[\s_-]*only\s*\]/gi);
    for (const token of tokens) {
      if (token.index !== 0 || token[0] !== CONTEXT_ONLY_MARKER) {
        return `Q${index + 1} has an invalid context-only marker in ${JSON.stringify(text)}`;
      }
    }
    if (text.startsWith(CONTEXT_ONLY_MARKER)) {
      const question = text.slice(CONTEXT_ONLY_MARKER.length);
      if (!/^\s/.test(question) || !question.trim()) {
        return `Q${index + 1} has an invalid context-only marker in ${JSON.stringify(text)}`;
      }
    }
  }
  return null;
}

export function questionsFromTexts(texts = []) {
  const refusal = questionKindRefusal(texts);
  if (refusal) throw new Error(refusal);
  return texts.map((text, index) => {
    const marked = text.startsWith(CONTEXT_ONLY_MARKER);
    return {
      id: `Q${index + 1}`,
      text: marked ? text.slice(CONTEXT_ONLY_MARKER.length).replace(/^\s+/, '') : text,
      kind: marked ? QUESTION_KIND.STARTUP_CONTEXT : QUESTION_KIND.CODE_REQUIRED,
    };
  });
}
