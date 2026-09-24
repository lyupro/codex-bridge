/**
 * Reads child-process calls out of source text for the guards that hold every call in `src/` and `cli/`
 * to one rule each (no shell, hidden window). Comments are dropped and strings kept opaque, so text that
 * merely mentions an API is neither a call nor an import.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PROCESS_APIS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
export const SHELL_APIS = ['exec', 'execSync'];
export const identifier = (token) => /^[A-Za-z_$][\w$]*$/.test(token || '');
export const unquote = (token) => /^["'`]/.test(token || '') ? token.slice(1, -1) : token;

export function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [file] : [];
  });
}

// Keep strings opaque while removing comments: text mentioning an API is not a call/import.
export function tokensWithoutComments(source) {
  const tokens = source.match(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][\w$]*|\.\.\.|===|!==|==|!=|=>|\?\.|[^\s]/g) || [];
  return tokens.filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
}

export function expressionEnd(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (['(', '[', '{'].includes(token)) depth += 1;
    else if ([')', ']', '}'].includes(token)) {
      if (depth === 0) return index;
      depth -= 1;
    } else if (depth === 0 && [',', ';'].includes(token)) return index;
  }
  return tokens.length;
}

export function argumentsFrom(tokens, start) {
  const args = [];
  while (start < tokens.length) {
    const end = expressionEnd(tokens, start);
    args.push(tokens.slice(start, end));
    if (tokens[end] !== ',') break;
    start = end + 1;
  }
  return args;
}

export function bindingsFrom(tokens) {
  const bindings = new Map();
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!identifier(tokens[index]) || tokens[index + 1] !== '=' || tokens[index - 1] === '.') continue;
    const value = tokens.slice(index + 2, expressionEnd(tokens, index + 2));
    const values = bindings.get(tokens[index]) || [];
    values.push(value);
    bindings.set(tokens[index], values);
  }
  return bindings;
}

export function importsFrom(tokens) {
  const apis = new Set(PROCESS_APIS);
  const namespaces = new Set();
  let forbidden = false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'import' || tokens[index + 1] === '(') continue;
    let end = index + 1;
    while (end < tokens.length && !['from', ';'].includes(tokens[end])) end += 1;
    if (!['node:child_process', 'child_process'].includes(unquote(tokens[end + 1]))) continue;
    if (identifier(tokens[index + 1])) namespaces.add(tokens[index + 1]);
    for (let at = index + 1; at < end; at += 1) {
      if (tokens[at] === '*' && tokens[at + 1] === 'as') namespaces.add(tokens[at + 2]);
      if (tokens[at - 1] !== '{' && tokens[at - 1] !== ',') continue;
      const imported = unquote(tokens[at]);
      if (SHELL_APIS.includes(imported)) forbidden = true;
      if (PROCESS_APIS.includes(imported)) {
        apis.add(tokens[at + 1] === 'as' ? tokens[at + 2] : imported);
      }
    }
  }
  return { apis, namespaces, forbidden };
}

export function refersToApi(expression, apis, namespaces, bindings, seen = new Set()) {
  if (expression.length === 3 && namespaces.has(expression[0]) && expression[1] === '.') {
    return PROCESS_APIS.includes(expression[2]);
  }
  if (expression.length !== 1 || !identifier(expression[0])) return false;
  const [name] = expression;
  if (apis.has(name)) return true;
  if (seen.has(name)) return false;
  const next = new Set([...seen, name]);
  return (bindings.get(name) || []).some((value) => refersToApi(value, apis, namespaces, bindings, next));
}
