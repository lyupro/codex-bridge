/** Plan_19 had to repair drift between duplicated CLI spellings, so shell-unsafe sequences must never be listed anywhere else. */

export const SHELL_UNSAFE_SEQUENCES = Object.freeze([
  '`',
  '$(',
  '${',
  '&&',
  '||',
  '|',
  ';',
]);

/** Returns the first forbidden sequence in reading order, preferring a compound operator at a tie. */
export function firstShellUnsafeSequence(value) {
  const text = String(value);
  let first = null;
  let firstIndex = -1;
  for (const sequence of SHELL_UNSAFE_SEQUENCES) {
    const index = text.indexOf(sequence);
    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
      first = sequence;
      firstIndex = index;
    }
  }
  return first;
}
