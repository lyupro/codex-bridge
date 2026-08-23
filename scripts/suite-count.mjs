/**
 * Compares the README's advertised suite size with what the suite actually reported.
 *
 * The number is prose, so nothing checked it: README said 705 tests while the suite ran 751, and
 * package.json still advertised 604 from three releases earlier. Both were found by eye during
 * the 0.5.3 release, which is the third release in a row where a shipped number was wrong. The
 * count is the first thing a reader judges the package by, and it goes stale silently with every
 * test added — so the runner that knows the real number is the place the claim is verified.
 */
import fs from 'node:fs';

export const SUITE_CLAIM =
  /\*\*(\d+) automated tests: (\d+) passing and (\d+) skipped\*\*/;

/** Read the TAP summary a second reporter wrote; null when the file says nothing usable. */
export function reportedCounts(tapOutput) {
  if (typeof tapOutput !== 'string' || !tapOutput.trim()) return null;
  const read = (key) => {
    const found = tapOutput.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return found ? Number(found[1]) : null;
  };
  const tests = read('tests');
  const pass = read('pass');
  const skipped = read('skipped');
  if (tests === null || pass === null || skipped === null) return null;
  return { tests, pass, skipped };
}

/** Read the claim out of README text; null when the sentence is absent. */
export function claimedCounts(readmeText) {
  const found = typeof readmeText === 'string' ? readmeText.match(SUITE_CLAIM) : null;
  if (!found) return null;
  return { tests: Number(found[1]), pass: Number(found[2]), skipped: Number(found[3]) };
}

/**
 * Return the message a mismatch should print, or null when the claim holds. A missing claim is a
 * mismatch too: the sentence is what the gate protects, and deleting it must not silence the gate.
 */
export function suiteCountMismatch(readmeText, tapOutput) {
  const reported = reportedCounts(tapOutput);
  if (!reported) return null;
  const claimed = claimedCounts(readmeText);
  if (!claimed) {
    return 'README no longer states the suite size. Restore the sentence: '
      + `**${reported.tests} automated tests: ${reported.pass} passing and ${reported.skipped} skipped**.`;
  }
  if (claimed.tests === reported.tests
    && claimed.pass === reported.pass
    && claimed.skipped === reported.skipped) {
    return null;
  }
  return 'README states the wrong suite size. '
    + `It says ${claimed.tests} tests (${claimed.pass} passing, ${claimed.skipped} skipped); `
    + `this run had ${reported.tests} (${reported.pass} passing, ${reported.skipped} skipped). `
    + 'Update the sentence in README.md before the release.';
}

export function readmeText(readmePath) {
  try {
    return fs.readFileSync(readmePath, 'utf8');
  } catch {
    return null;
  }
}
