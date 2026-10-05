/** Plan_63 D5/D7: share the same comment-aware spelling scan across both channel guards. */
import { ORDER_AGENTS, orderLabelsFor } from '../src/home/lib/order-schema.mjs';

// The registry's command-line flags, not orderInputName: at the channel switch orderInputName starts answering
// with header labels, and these flags are exactly what must then stay dead in code and tests (Plan_63 D7).
export function orderSpellings() {
  return [...new Set(ORDER_AGENTS.flatMap((agent) => orderLabelsFor(agent).map(({ flag }) => flag)))];
}

export function findSpellings(source, file) {
  // Keep quoted text: a flag in a string is precisely the instruction this guard must catch.
  // Mask comments without removing line breaks so diagnostics still name the original line.
  const code = source.replace(
    /'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token) => token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token,
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
