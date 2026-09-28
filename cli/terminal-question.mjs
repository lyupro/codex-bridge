/**
 * The one terminal yes/no question. Plan_65 D9 needs three outcomes kept apart, because each leads
 * to a different action: 'yes', 'no' (a no, a bare Enter, or input that ended — EOF is no answer,
 * never consent) and 'cancel' (Ctrl+C: the caller exits 130 and changes nothing). prune's private
 * copy folded all of them into "no"; a second copy in install would have drifted from it.
 */
import readline from 'node:readline/promises';

// One spelling only. A guard that answers to several option names is a guard with several ways
// to be switched off by accident.
export function isInteractive(options) {
  if (options.isTTY !== undefined) return Boolean(options.isTTY);
  return Boolean((options.stdin || process.stdin).isTTY);
}

function outcome(answer) {
  if (answer === 'cancel') return 'cancel';
  return answer === true || (typeof answer === 'string' && /^(y|yes)$/i.test(answer.trim()))
    ? 'yes'
    : 'no';
}

/** `options.prompt` is the test seam: it may answer a boolean, a string, or the string 'cancel'. */
export async function askYesNo(question, options) {
  if (options.prompt !== undefined) return outcome(await options.prompt(question));

  const input = options.stdin || process.stdin;
  const output = options.promptOutput || process.stderr;
  const interfaceHandle = readline.createInterface({ input, output });
  const ended = new Promise((resolve) => {
    interfaceHandle.once('SIGINT', () => resolve('cancel'));
    interfaceHandle.once('close', () => resolve('no'));
  });
  // A closed interface rejects the pending question; the close itself already decided the answer.
  const answered = interfaceHandle.question(`${question} [y/N] `).then(outcome, () => ended);
  try {
    return await Promise.race([answered, ended]);
  } finally {
    interfaceHandle.close();
  }
}
