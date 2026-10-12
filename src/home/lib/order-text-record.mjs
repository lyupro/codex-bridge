/** Plan_79 D5/D6 records issued order text and journals unregistered text only inside test roots. */
import fs from 'node:fs';
import path from 'node:path';

const recorded = new Set();

export function recordOrderText(text) {
  if (process.env.CODEX_BRIDGE_TEST_TMP && typeof text === 'string' && text.length) {
    recorded.add(text);
  }
  return text;
}

function recordedComposition(message) {
  let remainder = message;
  for (const text of [...recorded].sort((left, right) => right.length - left.length)) {
    remainder = remainder.split(text).join('');
  }
  return /^[\s:;,.]*$/.test(remainder);
}

function journalViolation(root, entry) {
  // Plan_79 B3j D5: retain die's caller and its caller even under a host's shallow limit.
  const frameLimit = Error.stackTraceLimit;
  let stack;
  try {
    Error.stackTraceLimit = Math.max(frameLimit || 0, 32);
    // Skip this shared writer so the checker, builder/transport and caller keep their positions.
    stack = new Error().stack.split('\n').slice(2).join('\n');
  } finally {
    Error.stackTraceLimit = frameLimit;
  }
  // Plan_79 B3j D5 acceptance: only the immediate builder/transport caller owns the refusal.
  const caller = stack.split('\n')[2]?.trim() ?? null;
  const directory = path.join(root, 'order-text-violations');
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, `${process.pid}.jsonl`), JSON.stringify({
    ...entry, pid: process.pid, caller, stack,
  }) + '\n');
}

// Plan_79 D6: check text inputs before a builder can launder them into recorded output.
export function checkOrderTextParameters(builder, key, values, data) {
  const root = process.env.CODEX_BRIDGE_TEST_TMP;
  if (!root) return values;
  try {
    for (const [parameter, value] of Object.entries(values)) {
      if (data.includes(parameter) || value === undefined) continue;
      if (typeof value === 'string' && recordedComposition(value)) continue;
      // Never serialize/coerce an arbitrary object: even circular objects must be journaled.
      journalViolation(root, {
        kind: 'parameter', builder, key, parameter,
        message: typeof value === 'string' ? value : undefined, valueType: typeof value,
      });
    }
  } catch {}
  return values;
}

export function checkOutgoingRefusal(message, transport) {
  const root = process.env.CODEX_BRIDGE_TEST_TMP;
  if (!root) return message;
  // Plan_79 D5: a refusal's expected exception must not hide the journal or change its transport.
  try {
    if (!recordedComposition(message)) {
      journalViolation(root, { kind: 'outgoing', transport, message });
    }
  } catch {}
  return message;
}
