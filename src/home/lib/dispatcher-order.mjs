/** Reads and compares the order identity carried between dispatcher hook boundaries. */
import fs from 'node:fs';
import { parseJsonText } from './json-file.mjs';
import { extractValue } from './required-inputs.mjs';

/** The transcript is diagnostic evidence; malformed or unavailable evidence must fail open. */
export function transcriptOrderId(transcriptPath) {
  try {
    const firstEntry = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/, 1)[0];
    const transcriptEntry = parseJsonText(transcriptPath, firstEntry);
    const content = transcriptEntry?.message?.content;
    const promptText = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
        : '';
    return String(extractValue(promptText, 'order id') || '').trim();
  } catch {
    return '';
  }
}

/** On 2026-08-15 another order's saved reply was returned as the current run's verdict. */
export function runOrderMismatch(orderedOrderId, runStatus, runDir) {
  const ordered = String(orderedOrderId ?? '').trim();
  const recorded = String(runStatus?.order_id ?? '').trim();
  if (!ordered || !recorded || ordered === recorded) return null;
  return {
    reason: `Contract violated: the dispatcher was ordered order id ${JSON.stringify(ordered)}, ` +
      `but run folder ${runDir} records order_id ${JSON.stringify(recorded)}. Run the ordered ` +
      'order id and return that run\'s stdout verbatim.',
    observed: `The dispatcher transcript orders ${JSON.stringify(ordered)}, but status.json in ` +
      `${runDir} records order_id=${JSON.stringify(recorded)}. Run the ordered order id and ` +
      `return that run's stdout verbatim.`,
  };
}
