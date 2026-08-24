/** Shapes how one diagnosis line looks. */

// Built from a character code rather than written as an escape: an escape sequence in this file
// survives every editor, but not every tool that has rewritten it — a literal escape byte landed
// here once during the Plan_52 split and is invisible in diffs and greps, which is exactly the kind
// of character a source file should not carry silently.
const ESC = String.fromCharCode(27);
const WARNING = `${ESC}[33m`;
const RESET = `${ESC}[0m`;

export function check(key, status, value) {
  return { key, status, value };
}

export function renderDoctor(result) {
  return result.checks.map(({ key, status, value }) => {
    if ((key === 'agents' || key === 'command') && status !== 'ok') return value;
    const rendered = `[${status}] ${key}: ${value}`;
    return ['retention', 'conventions', 'permissions', 'liveRuns', 'hostContract'].includes(key) && status === 'warn'
      ? `${WARNING}${rendered}${RESET}`
      : rendered;
  }).join('\n');
}
