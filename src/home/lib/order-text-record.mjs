/** Plan_79 D5/D6 records issued order text and journals unregistered text only inside test roots. */
import fs from 'node:fs';
import path from 'node:path';

// Plan_79 D9: EX_SOFTWARE is outside runner EXIT and Node's own 1-13;
// a journal fault must stop before a hook can swallow an exception or exit(0).
export const ORDER_TEXT_FAULT_EXIT = 70;

export function orderTextFaultDirectory(root) {
  return path.join(path.dirname(root), path.basename(root) + '-faults');
}

const recorded = new Set();

export function recordOrderText(text) {
  if (process.env.CODEX_BRIDGE_TEST_TMP && typeof text === 'string' && text.length) {
    recorded.add(text);
  }
  return text;
}

// Plan_79 D6/D8: only catalog builders may pass their entry.message; the producer guard
// rejects caller-supplied renders after the B5b1 handwritten deny-frame acceptance probe.
export function checkedOrderText(builder, key, values, data, render) {
  checkOrderTextParameters(builder, key, values, data);
  return recordOrderText(render(values));
}

function recordedComposition(message) {
  let remainder = message;
  for (const text of [...recorded].sort((left, right) => right.length - left.length)) {
    remainder = remainder.split(text).join('');
  }
  return /^[\s:;,.]*$/.test(remainder);
}

function journalViolation(root, entries) {
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
  const journal = entries.map((entry) => ({ ...entry, pid: process.pid, caller, stack }));
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, `${process.pid}.jsonl`),
      journal.map((entry) => JSON.stringify(entry) + '\n').join(''));
  } catch (error) {
    journalFault(root, journal, error);
  }
}

// Plan_79 D9 (review B10a): the module's only catch hands a failed write here, and this never
// returns. finally ends the process even when stderr or the marker fails, so neither an enclosing
// catch in a hook nor its exit(0) can hide the violation; the marker sits beside the test root.
function journalFault(root, journal, error) {
  const lines = journal.map((entry) => JSON.stringify({ ...entry, error: error?.message }) + '\n');
  try {
    fs.writeSync(2, lines.map((line) => `order-text-record: journal write failed: ${line}`).join(''));
    const faults = orderTextFaultDirectory(root);
    fs.mkdirSync(faults, { recursive: true });
    fs.appendFileSync(path.join(faults, `${process.pid}.jsonl`), lines.join(''));
  } finally {
    process.exit(ORDER_TEXT_FAULT_EXIT);
  }
}

// Plan_79 D6: check text inputs before a builder can launder them into recorded output.
export function checkOrderTextParameters(builder, key, values, data) {
  const root = process.env.CODEX_BRIDGE_TEST_TMP;
  if (!root) return values;
  const entries = [];
  for (const [parameter, value] of Object.entries(values)) {
    if (data.includes(parameter) || value === undefined) continue;
    if (typeof value === 'string' && recordedComposition(value)) continue;
    // Never serialize/coerce an arbitrary object: even circular objects must be journaled.
    entries.push({
      kind: 'parameter', builder, key, parameter,
      message: typeof value === 'string' ? value : undefined, valueType: typeof value,
    });
  }
  if (entries.length) journalViolation(root, entries);
  return values;
}

export function checkOutgoingRefusal(message, transport) {
  const root = process.env.CODEX_BRIDGE_TEST_TMP;
  if (!root) return message;
  // Plan_79 D9: non-string text is a violation, without serializing arbitrary objects.
  if (typeof message !== 'string') {
    journalViolation(root, [{ kind: 'outgoing', transport, valueType: typeof message }]);
  } else if (!recordedComposition(message)) {
    journalViolation(root, [{ kind: 'outgoing', transport, message }]);
  }
  return message;
}
