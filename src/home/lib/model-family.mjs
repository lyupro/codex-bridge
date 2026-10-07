/**
 * Parses model families by id structure, Plan_67 D5, without a model id literal in code:
 * an id table would become stale with every model release and create false mismatch warnings.
 * D5 (b) treats unparsed ids as no evidence, rather than as matches or violations.
 */

// These are host aliases, not model ids or family pins (Plan_67 D5).
export const NON_FAMILY_ALIASES = Object.freeze(['inherit', 'default', 'opusplan']);

const isAsciiLetters = (value) => value.length > 0 && !/[^A-Za-z]/.test(value);

export function modelFamily(value) {
  if (typeof value !== 'string') return null;
  const tokens = value.replace(/\[[^\[\]]*\]$/, '').split(/[-.@]/);
  const claudeIndex = tokens.findIndex((token) => token.toLowerCase() === 'claude');
  if (claudeIndex !== -1) {
    const family = tokens.slice(claudeIndex + 1).find(isAsciiLetters);
    return family ? family.toLowerCase() : null;
  }
  if (tokens.length !== 1 || !isAsciiLetters(tokens[0])) return null;
  const family = tokens[0].toLowerCase();
  return NON_FAMILY_ALIASES.includes(family) ? null : family;
}

export function compareModelFamilies({ pinFamily, modelIds }) {
  const families = new Set();
  let unparsed = 0;
  for (const id of modelIds) {
    const family = modelFamily(id);
    if (family === null) unparsed += 1;
    else families.add(family);
  }
  const parsed = [...families];
  const verdict = pinFamily === null || parsed.length === 0
    ? 'undetermined'
    : parsed.some((family) => family !== pinFamily) ? 'violation' : 'match';
  return { verdict, parsed, unparsed };
}
