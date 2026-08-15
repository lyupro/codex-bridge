/**
 * Reads and normalizes the flat frontmatter shipped by this package.
 *
 * The 2026-08-10 agent-registration incident showed that placeholder text can turn a previously
 * plain YAML value into invalid syntax. Keeping this boundary deliberately flat makes host
 * readability testable without adding a general YAML parser or changing markdown bodies.
 */

const PLAIN_START = /^(?:[-?:](?:[ \t]|$)|[,\[\]{}#&*!|>'"%@`])/;

function locateFrontmatter(content) {
  const firstBreak = content.indexOf('\n');
  if (firstBreak === -1 || content.slice(0, firstBreak).replace(/\r$/, '') !== '---') return null;

  const blockStart = firstBreak + 1;
  let lineStart = blockStart;
  while (lineStart <= content.length) {
    const nextBreak = content.indexOf('\n', lineStart);
    const lineEnd = nextBreak === -1 ? content.length : nextBreak;
    if (content.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { blockStart, blockEnd: lineStart };
    }
    if (nextBreak === -1) break;
    lineStart = nextBreak + 1;
  }
  throw new Error('frontmatter closing delimiter is missing');
}

function blockLines(block) {
  const lines = [];
  let start = 0;
  while (start < block.length) {
    const nextBreak = block.indexOf('\n', start);
    const end = nextBreak === -1 ? block.length : nextBreak;
    const hasCarriageReturn = block[end - 1] === '\r';
    lines.push({
      text: block.slice(start, hasCarriageReturn ? end - 1 : end),
      ending: nextBreak === -1 ? '' : hasCarriageReturn ? '\r\n' : '\n',
    });
    if (nextBreak === -1) break;
    start = nextBreak + 1;
  }
  return lines;
}

function splitEntry(line) {
  const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
  if (!match) throw new Error(`frontmatter line is not a flat key/value entry: ${line}`);
  const remainder = match[2];
  if (remainder && !/^[ \t]/.test(remainder)) {
    throw new Error(`frontmatter value for ${match[1]} must follow YAML separator whitespace`);
  }
  return { key: match[1], rawValue: remainder ? remainder.slice(1) : '' };
}

function decodeDoubleQuoted(value) {
  if (!value.endsWith('"')) return null;
  let decoded = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === '"') return null;
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped !== '\\' && escaped !== '"') return null;
    decoded += escaped;
    index += 1;
  }
  return decoded;
}

function decodeSingleQuoted(value) {
  if (!value.endsWith("'")) return null;
  const inner = value.slice(1, -1);
  if (/(^|[^'])'(?:[^']|$)/.test(inner)) return null;
  return inner.replaceAll("''", "'");
}

function quotedValue(value) {
  if (value.startsWith('"')) return decodeDoubleQuoted(value);
  if (value.startsWith("'")) return decodeSingleQuoted(value);
  return undefined;
}

function plainScalarIsSafe(value) {
  return value.length > 0
    && value === value.trim()
    && !PLAIN_START.test(value)
    && !/:[ \t]/.test(value)
    && !/[ \t]#/.test(value);
}

function parseValue(rawValue) {
  const decoded = quotedValue(rawValue);
  if (decoded !== undefined) {
    if (decoded === null) throw new Error('frontmatter contains an invalid quoted value');
    return decoded;
  }
  if (!plainScalarIsSafe(rawValue)) {
    throw new Error(`frontmatter contains an invalid plain scalar: ${rawValue}`);
  }
  return rawValue;
}

function encodeValue(value) {
  const decoded = quotedValue(value);
  const intended = decoded === undefined || decoded === null ? value : decoded;
  if (decoded === undefined && plainScalarIsSafe(value)) return value;
  return `"${intended.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function parseFrontmatter(content) {
  const bounds = locateFrontmatter(content);
  if (!bounds) return null;
  const values = {};
  for (const { text } of blockLines(content.slice(bounds.blockStart, bounds.blockEnd))) {
    const { key, rawValue } = splitEntry(text);
    if (Object.hasOwn(values, key)) throw new Error(`frontmatter contains duplicate key: ${key}`);
    values[key] = parseValue(rawValue);
  }
  return values;
}

export function normalizeFrontmatter(content) {
  const bounds = locateFrontmatter(content);
  if (!bounds) return content;
  const keys = new Set();
  const normalized = blockLines(content.slice(bounds.blockStart, bounds.blockEnd)).map(({ text, ending }) => {
    const { key, rawValue } = splitEntry(text);
    if (keys.has(key)) throw new Error(`frontmatter contains duplicate key: ${key}`);
    keys.add(key);
    return `${key}: ${encodeValue(rawValue)}${ending}`;
  }).join('');
  return `${content.slice(0, bounds.blockStart)}${normalized}${content.slice(bounds.blockEnd)}`;
}
