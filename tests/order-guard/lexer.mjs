/** Strips comments and tokenizes refusal-guard input while retaining original offsets and template expressions. */
export const lineAt = (source, offset) => source.slice(0, offset).split(/\r\n|\r|\n/).length;

export function lex(source) {
  const tokens = [];
  const comments = [];
  const add = (start, end, literal = false) => {
    const token = { value: source.slice(start, end), start, end, literal };
    tokens.push(token);
    return token;
  };
  const quotedEnd = (start) => {
    let cursor = start + 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') cursor += 2;
      else if (source[cursor++] === source[start]) break;
    }
    return cursor;
  };
  const regexEnd = (start) => {
    let inClass = false;
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '\r' || char === '\n') return start + 1;
      if (char === '\\') cursor += 1;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        cursor += 1;
        while (/[a-z]/i.test(source[cursor] ?? '')) cursor += 1;
        return cursor;
      }
    }
    return start + 1;
  };
  const scan = (start, interpolation = false) => {
    let cursor = start;
    let braces = 0;
    let regexAllowed = true;
    let previousWord = '';
    const controlParens = [];
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (/\s/.test(char)) { cursor += 1; continue; }
      if (char === '/' && (next === '/' || next === '*')) {
        const commentStart = cursor;
        if (next === '/') {
          while (cursor < source.length && !/[\r\n]/.test(source[cursor])) cursor += 1;
          const comment = source.slice(commentStart, cursor);
          comments.push({ start: commentStart, end: cursor, value: comment });
        } else {
          const end = source.indexOf('*/', cursor + 2);
          cursor = end < 0 ? source.length : end + 2;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        const end = quotedEnd(cursor);
        add(cursor, end, true);
        cursor = end;
        regexAllowed = false;
        previousWord = '';
        continue;
      }
      if (char === '`') {
        const token = add(cursor, cursor + 1, true);
        cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === '\\') cursor += 2;
          else if (source[cursor] === '`') { cursor += 1; break; }
          else if (source[cursor] === '$' && source[cursor + 1] === '{') cursor = scan(cursor + 2, true);
          else cursor += 1;
        }
        token.end = cursor;
        regexAllowed = false;
        previousWord = '';
        continue;
      }
      if (char === '/' && regexAllowed) {
        const end = regexEnd(cursor);
        if (end > cursor + 1) {
          add(cursor, end);
          cursor = end;
          regexAllowed = false;
          previousWord = '';
          continue;
        }
      }
      if (/[\w$]/.test(char)) {
        const wordStart = cursor++;
        while (/[\w$]/.test(source[cursor] ?? '')) cursor += 1;
        previousWord = add(wordStart, cursor).value;
        regexAllowed = /^(?:return|throw|case|typeof|void|delete|new|in|of|yield|await|else|do)$/.test(previousWord);
        continue;
      }
      if (char === '}' && interpolation && braces === 0) return cursor + 1;
      if (char === '{') braces += 1;
      if (char === '}') braces -= 1;
      if (char === '(') {
        controlParens.push(/^(?:if|while|for|with|switch|catch)$/.test(previousWord));
        regexAllowed = true;
      } else if (char === ')') regexAllowed = controlParens.pop() === true;
      else regexAllowed = '([{,=:!&|?};+-*%<>~^'.includes(char);
      add(cursor, cursor + 1);
      cursor += 1;
      previousWord = '';
    }
    return cursor;
  };
  scan(0);
  return { tokens, comments };
}

