/** Plan_63 D5/D7: share the same comment-aware spelling scan across both channel guards. */
// Plan_63 D2/D9: these spellings must stay dead in code and tests. This frozen, test-only list
// is a negative contract, never derived from runtime metadata.
const RETIRED_ORDER_FLAGS = Object.freeze([
  '--order-id', '--scope', '--scope-new', '--repo', '--slug', '--effort',
  '--changeset', '--phase', '--continue',
]);

export function orderSpellings() {
  return RETIRED_ORDER_FLAGS;
}

export function findSpellings(source, file) {
  // Keep quoted text: a flag in a string is precisely the instruction this guard must catch.
  // Plan_63 C3/C4: regex literals can contain quotes; do not let them swallow a following comment.
  // Mask comments without removing line breaks so diagnostics still name the original line.
  const code = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|\/(?![/*])(?:\\[\s\S]|\[(?:\\[\s\S]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[dgimsuvy]*|'(?:\\[\s\S]|[^'\\\r\n])*'|"(?:\\[\s\S]|[^"\\\r\n])*"|\x60(?:\\[\s\S]|[^\x60\\])*\x60/g,
    (token) => /^(?:\/\/|\/\*)/.test(token) ? token.replace(/[^\r\n]/g, ' ') : token,
  );
  const findings = [];
  for (const spelling of orderSpellings()) {
    const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of code.matchAll(new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, 'g'))) {
      const line = code.slice(0, match.index).split('\n').length;
      findings.push({ file, line, spelling });
    }
  }
  return findings;
}
