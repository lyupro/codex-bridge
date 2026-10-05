/**
 * Owns one responsibility: the grammar of a single order value.
 * Plan_63 D9: call and header readers share this leaf without importing either registry.
 */
import path from 'node:path';

const PLACEHOLDER_VALUES = new Set(['todo', 'tbd', 'label', 'none', 'order id', 'scope', 'xxx']);

function cleanValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^([`'\"])(.*)\1$/, '$2').trim();
}

export function isAbsoluteTaskFilePath(value) {
  const cleaned = cleanValue(value);
  return path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned);
}

export function isPlaceholder(value) {
  const cleaned = cleanValue(value);
  if (!cleaned) return true;
  if (cleaned.startsWith('<') && cleaned.endsWith('>')) return true;
  return PLACEHOLDER_VALUES.has(cleaned.replace(/[.,;:]+$/, '').trim().toLowerCase());
}

// Plan_59: scope is a real phase value, while it remains a placeholder for existing inputs. Plan_63 D5: none is a
// real reasoning effort the flag channel always accepted, so the header channel must not refuse it as a template.
const REAL_VALUES = Object.freeze({ phase: 'scope', effort: 'none' });
export const isInputPlaceholder = (value, label) =>
  !(Object.hasOwn(REAL_VALUES, label) && cleanValue(value) === REAL_VALUES[label]) && isPlaceholder(value);

// Plan_75 D5, 2026-10-03 20:42: header parsing must reuse the existing grant value grammar.
export function splitGrantValue(value) {
  if (isPlaceholder(value)) return null;

  for (const separator of [/\s+—\s+/, /\s+-\s+/, /\s*:\s*/]) {
    const match = value.match(new RegExp(`^(.+?)${separator.source}(.+)$`));
    if (!match) continue;
    const run = cleanValue(match[1]);
    const reason = cleanValue(match[2]);
    if (isPlaceholder(run) || isPlaceholder(reason)) return null;
    return { run, reason };
  }
  return null;
}

