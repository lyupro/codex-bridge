/**
 * Plan_79 B3g / D3: admission refusals must not acquire text outside the registries.
 * This is a text guard, not a JavaScript parser or general data-flow resolver:
 * - Strip line/block comments lexically, retaining original offsets and physical lines.
 *   Quoted strings, regexes and template text are opaque; template expressions are scanned.
 *   Regexes start at expression-start tokens or after control-statement parentheses.
 * - Check the first argument of die/deny/new Error/new RunnerUsageError/problems.push,
 *   object properties reason/refusal, and return values. Whitespace, comments and grouping
 *   parentheses may intervene. A newline after return ends that return (JavaScript ASI).
 * - A value beginning with a quoted string or ANY template is a violation, including a
 *   template wrapping a registry builder. Identifiers and orderRuleMessage/orderDiagnosticMessage
 *   calls are allowed; builder key/parameter literals are not themselves refusal messages.
 * - Plan_79 B3i / D3 (A3 pre-mortem): text outside the registry must not hide after a name.
 *   Quoted/template operands of + anywhere in a message, including grouping parentheses,
 *   and literal elements of message arrays or arrays joined into messages fail at their
 *   opening lines. Call arguments remain opaque, including builder inputs and join separators.
 * - Same-file literal binding rule: message identifiers are checked against const/let/var
 *   initializers and plain assignments of that name, regardless of declaration/use order.
 *   Initializers and assignments use the same literal/composition scan and opening lines.
 *   Calls, destructuring and other identifiers are not resolved or followed.
 * - Plan_79 B3h / D3: same-file functions forwarding a parameter to a refusal message
 *   are refusal constructs at that argument position, including array/concatenation/template
 *   messages and chains of wrappers discovered to a fixed point; builder arguments are opaque.
 * - Only a trailing line comment on the literal's opening line can exempt it:
 *   // order-guard: not-a-refusal — <reason of at least three words>
 *   Every accepted exemption is printed for review. Missing/short reasons exempt nothing.
 * Pending admission files are visibly skipped until their Plan_79 migration slice lands.
 */
import { lex, lineAt } from './lexer.mjs';

function optOutComments(source, comments) {
  const optOuts = new Map();
  for (const { start, value } of comments) {
    const marker = /^\/\/\s*order-guard: not-a-refusal —\s*(.*?)\s*$/.exec(value);
    const lineStart = Math.max(source.lastIndexOf('\n', start - 1), source.lastIndexOf('\r', start - 1)) + 1;
    const words = marker?.[1].match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
    if (words.length >= 3 && /\S/.test(source.slice(lineStart, start))) {
      optOuts.set(lineAt(source, start), value);
    }
  }
  return optOuts;
}

/** Checks refusal messages and same-file forwarding wrappers without resolving arbitrary JavaScript data flow. */
export function checkRefusalSites(source, file) {
  const { tokens, comments } = lex(source);
  const optOuts = optOutComments(source, comments);
  const violations = [];
  const messageNames = new Set();
  const at = (index) => tokens[index]?.value;
  const groups = [];
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (['(', '{', '['].includes(at(index))) stack.push(index);
    else if ([')', '}', ']'].includes(at(index)) && stack.length) groups.push([stack.pop(), index]);
  }
  const closes = new Map(groups);
  const opens = new Map(groups.map(([start, end]) => [end, start]));
  const identifier = (index) => /^[A-Za-z_$][\w$]*$/.test(at(index) ?? '') && !tokens[index]?.literal;
  const after = (index) => {
    if (at(index) === '`') {
      const end = tokens[index].end;
      while (tokens[++index]?.start < end) { /* Template expressions belong to this argument. */ }
      return index;
    }
    return (closes.get(index) ?? index) + 1;
  };
  const expressionEnd = (start, limit = tokens.length) => {
    let end = start;
    while (end < limit && ![',', ';', ')', ']', '}'].includes(at(end))) end = after(end);
    return end;
  };
  const argumentsAt = (open) => {
    const end = closes.get(open);
    const args = [];
    for (let start = open + 1; start < end;) {
      const stop = expressionEnd(start, end);
      args.push([start, stop]);
      start = stop + 1;
    }
    return args;
  };
  const messageLiterals = (start, end, leading = true) => {
    const literals = [];
    for (let index = start; index < end;) {
      const next = after(index);
      const operand = at(index - 1) === '+' || at(next) === '+';
      const first = leading && index === start;
      if (tokens[index]?.literal) {
        if (first || operand) literals.push(index);
      } else if (at(index) === '(' || at(index) === '[') {
        // B3i: inspect composition, but never reinterpret call arguments or member indices.
        const receiver = index > start && ((identifier(index - 1)
          && !['typeof', 'void', 'delete', 'await', 'yield', 'new', 'in', 'instanceof'].includes(at(index - 1)))
          || tokens[index - 1]?.literal || [')', ']', '.'].includes(at(index - 1)));
        const close = closes.get(index);
        if (!receiver && close !== undefined) {
          if (at(index) === '(') {
            literals.push(...messageLiterals(index + 1, close, first || operand));
          } else {
            for (let element = index + 1; element < close;) {
              if (at(element) === ',') { element += 1; continue; }
              const stop = expressionEnd(element, close);
              literals.push(...messageLiterals(element, stop));
              element = stop + 1;
            }
          }
        }
      }
      index = next;
    }
    return literals;
  };
  const functions = [];
  const declarations = new Set();
  const addFunction = (nameIndex, parameterRanges, bodyStart) => {
    if (!identifier(nameIndex)) return;
    const block = at(bodyStart) === '{';
    const bodyEnd = block ? closes.get(bodyStart) : expressionEnd(bodyStart);
    if (bodyEnd === undefined) return;
    const params = parameterRanges.map(([start]) => identifier(start) ? at(start) : null);
    functions.push({ name: at(nameIndex), params, start: bodyStart + Number(block), end: bodyEnd });
    declarations.add(nameIndex);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (at(index) === 'function') {
      let nameIndex = index + 1 + Number(at(index + 1) === '*');
      const open = identifier(nameIndex) ? nameIndex + 1 : nameIndex;
      const end = closes.get(open);
      if (at(open) !== '(' || at(end + 1) !== '{') continue;
      if (at(index - 1) === '=' && ['const', 'let', 'var'].includes(at(index - 3))) {
        if (identifier(nameIndex)) addFunction(nameIndex, argumentsAt(open), end + 1);
        nameIndex = index - 2;
      }
      addFunction(nameIndex, argumentsAt(open), end + 1);
    } else if (at(index) === '=' && at(index + 1) === '>') {
      const parameterStart = at(index - 1) === ')' ? opens.get(index - 1) : index - 1;
      const bindingEnd = parameterStart - Number(at(parameterStart - 1) === 'async');
      if (at(bindingEnd - 1) !== '=' || !['const', 'let', 'var'].includes(at(bindingEnd - 3))) continue;
      const params = at(parameterStart) === '(' ? argumentsAt(parameterStart) : [[parameterStart, index]];
      addFunction(bindingEnd - 2, params, index + 2);
    }
  }
  const wrappers = new Map();
  const sitesAt = (index) => {
    const word = at(index);
    let construct;
    let valueIndex;
    if (['die', 'deny'].includes(word) && at(index + 1) === '(') {
      construct = `${word}(`;
      valueIndex = index + 2;
    } else if (word === 'new' && ['Error', 'RunnerUsageError'].includes(at(index + 1)) && at(index + 2) === '(') {
      construct = `new ${at(index + 1)}(`;
      valueIndex = index + 3;
    } else if (word === 'problems' && at(index + 1) === '.' && at(index + 2) === 'push' && at(index + 3) === '(') {
      construct = 'problems.push(';
      valueIndex = index + 4;
    } else if (['reason', 'refusal', "'reason'", '"reason"', "'refusal'", '"refusal"'].includes(word)
        && ['{', ','].includes(at(index - 1)) && at(index + 1) === ':') {
      construct = `${word.replace(/['"]/g, '')}:`;
      valueIndex = index + 2;
    } else if (word === 'return') {
      if (/[\r\n]/.test(source.slice(tokens[index].end, tokens[index + 1]?.start))) return [];
      construct = 'return';
      valueIndex = index + 1;
    } else if (wrappers.has(word) && at(index + 1) === '(' && at(index - 1) !== '.' && !declarations.has(index)) {
      const args = argumentsAt(index + 1);
      return [...wrappers.get(word)].filter((position) => args[position])
        .map((position) => ({ construct: `${word}(`, start: args[position][0], end: args[position][1] }));
    } else return [];
    return [{ construct, start: valueIndex, end: expressionEnd(valueIndex) }];
  };
  const carriesParameter = (start, end, name) => {
    for (let index = start; index < end; index += 1) {
      if (at(index) === '{') { index = closes.get(index) ?? index; continue; }
      if (identifier(index) && at(index + 1) === '(') {
        const args = argumentsAt(index + 1);
        if ([...(wrappers.get(at(index)) ?? [])].some((position) => args[position]
            && carriesParameter(...args[position], name))) return true;
        index = closes.get(index + 1) ?? index;
        continue;
      }
      if (at(index) === name && !tokens[index].literal && at(index - 1) !== '.' && at(index + 1) !== ':') return true;
    }
    return false;
  };
  // Plan_79 B3h: discover chains in either definition order, retaining each message position.
  let changed;
  do {
    changed = false;
    for (const fn of functions) {
      const positions = wrappers.get(fn.name) ?? new Set();
      for (let index = fn.start; index < fn.end; index += 1) {
        if (functions.some((inner) => fn.start < inner.start && inner.start <= index && index < inner.end && inner.end <= fn.end)) continue;
        for (const site of sitesAt(index)) {
          fn.params.forEach((name, position) => {
            if (name && !positions.has(position) && carriesParameter(site.start, site.end, name)) {
              positions.add(position);
              changed = true;
            }
          });
        }
      }
      if (positions.size) wrappers.set(fn.name, positions);
    }
  } while (changed);
  const defaults = groups.filter(([start, end]) => at(start) === '('
    ? (at(end + 1) === '=' && at(end + 2) === '>')
      || (at(end + 1) === '{' && !['if', 'while', 'for', 'switch', 'with'].includes(at(start - 1)))
    : at(end + 1) === '=' || ['const', 'let', 'var'].includes(at(start - 1)));
  for (let index = 0; index < tokens.length; index += 1) {
    for (const { construct, start, end } of sitesAt(index)) {
      for (const literal of messageLiterals(start, end)) {
        const line = lineAt(source, tokens[literal].start);
        if (!optOuts.has(line)) violations.push(`${file}:${line}: ${construct} carries a literal message`);
      }
      let valueIndex = start;
      let grouping = 0;
      while (at(valueIndex) === '(') { valueIndex += 1; grouping += 1; }
      if (!tokens[valueIndex]?.literal) {
        let following = valueIndex + 1;
        while (grouping > 0 && at(following) === ')') { following += 1; grouping -= 1; }
        if (/^[A-Za-z_$][\w$]*$/.test(at(valueIndex) ?? '')
            && !['(', '.', '['].includes(at(following))) messageNames.add(at(valueIndex));
        continue;
      }
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const name = at(index);
    if (!messageNames.has(name) || at(index - 1) === '.' || at(index + 1) !== '='
        || ['=', '>'].includes(at(index + 2))
        || defaults.some(([start, end]) => start < index && index < end)) continue;
    const start = index + 2;
    for (const literal of messageLiterals(start, expressionEnd(start))) {
      const line = lineAt(source, tokens[literal].start);
      if (!optOuts.has(line)) violations.push(`${file}:${line}: ${name} is a literal message`);
    }
  }
  return { violations, optOuts: [...optOuts].map(([line, comment]) => `${file}:${line}: ${comment}`) };
}
