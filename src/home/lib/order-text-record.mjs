/** Plan_79 D5 records issued order text and journals unregistered refusal text only inside test roots. */
import fs from 'node:fs';
import path from 'node:path';

const recorded = new Set();

export function recordOrderText(text) {
  if (process.env.CODEX_BRIDGE_TEST_TMP && typeof text === 'string' && text.length) {
    recorded.add(text);
  }
  return text;
}

export function checkOutgoingRefusal(message, transport) {
  const root = process.env.CODEX_BRIDGE_TEST_TMP;
  if (!root) return message;
  // Plan_79 D5: a refusal's expected exception must not hide the journal or change its transport.
  try {
    let remainder = message;
    for (const text of [...recorded].sort((left, right) => right.length - left.length)) {
      remainder = remainder.split(text).join('');
    }
    if (!/^[\s:;,.]*$/.test(remainder)) {
      // Plan_79 B3j D5: retain die's caller and its caller even under a host's shallow limit.
      const frameLimit = Error.stackTraceLimit;
      let stack;
      try {
        Error.stackTraceLimit = Math.max(frameLimit || 0, 32);
        stack = new Error().stack.split('\n').slice(1).join('\n');
      } finally {
        Error.stackTraceLimit = frameLimit;
      }
      // Plan_79 B3j D5 acceptance: only the immediate transport caller owns the refusal.
      const caller = stack.split('\n')[2]?.trim() ?? null;
      const directory = path.join(root, 'order-text-violations');
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(path.join(directory, `${process.pid}.jsonl`), JSON.stringify({
        transport, message, pid: process.pid,
        caller, stack,
      }) + '\n');
    }
  } catch {}
  return message;
}
