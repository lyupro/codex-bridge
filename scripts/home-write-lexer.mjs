/**
 * Separates executable source from comments and literals for the home-write audit.
 * Plan_65 B1b moves lexing here so a malformed mask cannot hide a home writer.
 *
 * Regex literals are lexed as literals because the first audit did not: the `"` inside the pattern
 * at src/home/lib/config-edit.mjs:20 opened a "string" that masked the rest of that module, and the
 * one module writing the operator's config.json into the home passed the audit unseen (2026-09-25).
 */
export function lexSource(source) {
  const code = source.split('');
  const withoutComments = source.split('');
  const blank = (target, start, end) => {
    for (let index = start; index < end; index += 1) {
      if (source[index] !== '\n' && source[index] !== '\r') target[index] = ' ';
    }
  };
  const regexKeywords = new Set([
    'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await',
  ]);
  const expressionStart = new Set('([{,=:!&|?{};+-*%<>~^');

  const regexEnd = (start) => {
    let inClass = false;
    let escapedChar = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (char === '\n' || char === '\r') return -1;
      if (escapedChar) escapedChar = false;
      else if (char === '\\') escapedChar = true;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        while (/[A-Za-z]/.test(source[index + 1] ?? '')) index += 1;
        return index + 1;
      }
    }
    return -1;
  };

  const scanCode = (start, interpolation = false) => {
    let index = start;
    let braces = 0;
    let canStartRegex = true;
    const controlParens = [];
    let previousWord = '';
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];
      if (interpolation && char === '}') {
        if (braces === 0) {
          blank(code, index, index + 1);
          return index + 1;
        }
        braces -= 1;
      } else if (char === '{') {
        braces += 1;
      }

      if (char === '/' && (next === '/' || next === '*')) {
        const commentStart = index;
        if (next === '/') {
          index += 2;
          while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
        } else {
          index += 2;
          while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
          index = index < source.length ? index + 2 : source.length;
        }
        blank(withoutComments, commentStart, index);
        blank(code, commentStart, index);
        if (source.slice(commentStart, index).includes('\n') || source.slice(commentStart, index).includes('\r')) {
          canStartRegex = true;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        const quote = char;
        const stringStart = index++;
        let escapedChar = false;
        while (index < source.length) {
          const current = source[index++];
          if (escapedChar) escapedChar = false;
          else if (current === '\\') escapedChar = true;
          else if (current === quote) break;
        }
        blank(code, stringStart, index);
        canStartRegex = false;
        previousWord = '';
        continue;
      }

      if (char === '`') {
        const scanTemplate = (templateStart) => {
          let cursor = templateStart + 1;
          blank(code, templateStart, cursor);
          let escapedChar = false;
          while (cursor < source.length) {
            const current = source[cursor];
            if (escapedChar) {
              escapedChar = false;
              blank(code, cursor, cursor + 1);
              cursor += 1;
            } else if (current === '\\') {
              escapedChar = true;
              blank(code, cursor, cursor + 1);
              cursor += 1;
            } else if (current === '`') {
              blank(code, cursor, cursor + 1);
              return cursor + 1;
            } else if (current === '$' && source[cursor + 1] === '{') {
              blank(code, cursor, cursor + 2);
              cursor = scanCode(cursor + 2, true);
              escapedChar = false;
            } else {
              blank(code, cursor, cursor + 1);
              cursor += 1;
            }
          }
          return cursor;
        };
        index = scanTemplate(index);
        canStartRegex = false;
        previousWord = '';
        continue;
      }

      if (char === '/' && canStartRegex) {
        const end = regexEnd(index);
        if (end !== -1) {
          blank(code, index, end);
          index = end;
          canStartRegex = false;
          previousWord = '';
          continue;
        }
      }

      if (/\s/.test(char)) {
        if (char === '\n' || char === '\r') canStartRegex = true;
        index += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        const wordStart = index++;
        while (/[\w$]/.test(source[index] ?? '')) index += 1;
        previousWord = source.slice(wordStart, index);
        canStartRegex = regexKeywords.has(previousWord);
        continue;
      }
      if (/[0-9]/.test(char)) {
        index += 1;
        while (/[\w.]/.test(source[index] ?? '')) index += 1;
        canStartRegex = false;
        previousWord = '';
        continue;
      }

      if (char === '(') {
        controlParens.push(/^(?:if|while|for|with|switch|catch)$/.test(previousWord));
        canStartRegex = true;
      } else if (char === ')') {
        canStartRegex = controlParens.pop() === true;
      } else if (char === '[' || char === '{') {
        canStartRegex = true;
      } else if (char === ']') {
        canStartRegex = false;
      } else if (char === '/' && next === '=') {
        canStartRegex = true;
        index += 1;
      } else {
        canStartRegex = expressionStart.has(char);
      }
      previousWord = '';
      index += 1;
    }
    return index;
  };

  scanCode(0);
  return { code: code.join(''), withoutComments: withoutComments.join('') };
}
