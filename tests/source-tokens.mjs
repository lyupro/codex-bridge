/** Plan_80 E21: source tokenizer the answer-rule guards read judge code with. */
import assert from 'node:assert/strict';

// E21: inspect only the named judge, ignoring braces/returns in literals, comments and callbacks.
export function tokensOf(source) {
  const tokens = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\r\n\\])+\/[a-z]*|[A-Za-z_$][\w$]*|=>|[^\s]/g;
  return [...source.matchAll(tokens)]
    .filter(([token]) => !token.startsWith('//') && !token.startsWith('/*'))
    .map(([token]) => token);
}

export function closingToken(tokens, start) {
  const close = { '(': ')', '[': ']', '{': '}' }[tokens[start]];
  let depth = 1;
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index] === tokens[start]) depth += 1;
    if (tokens[index] === close && --depth === 0) return index;
  }
  throw new Error(`unclosed token: ${tokens[start]}`);
}

export function functionBody(tokens, name) {
  const start = tokens.findIndex((token, index) => token === 'function' && tokens[index + 1] === name);
  if (start < 0) throw new Error(`missing judge function: ${name}`);
  const bodyStart = closingToken(tokens, start + 2) + 1;
  assert.equal(tokens[bodyStart], '{');
  return tokens.slice(bodyStart + 1, closingToken(tokens, bodyStart));
}

