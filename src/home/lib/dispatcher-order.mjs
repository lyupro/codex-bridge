/** Reads and compares the order identity carried between dispatcher hook boundaries. */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText } from './json-file.mjs';
import { extractValue } from './required-inputs.mjs';

/** Implements Plan_62 D7: keeps untrusted ids from redirecting the host-owned subagent transcript path. */
export function ownTranscriptPath(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { transcript_path, session_id, agent_id } = payload;
  const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
  const unsafeSegment = (value) => value.includes('/') || value.includes('\\') || value.includes('..');
  if (!nonEmpty(transcript_path) || !nonEmpty(session_id) || !nonEmpty(agent_id)) return null;
  if (unsafeSegment(session_id) || unsafeSegment(agent_id)) return null;
  return path.join(path.dirname(transcript_path), session_id, 'subagents', `agent-${agent_id}.jsonl`);
}

function firstEntry(transcriptPath) {
  try {
    const line = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/, 1)[0];
    const entry = parseJsonText(transcriptPath, line);
    const content = entry?.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
        : '';
    return { type: entry?.type, text };
  } catch {
    return null;
  }
}

/** Reads the first user message; missing or malformed host transcript evidence fails closed. */
export function transcriptPrompt(transcriptPath) {
  const entry = firstEntry(transcriptPath);
  return entry?.type === 'user' ? entry.text : null;
}

/** The reply guard's transcript is diagnostic evidence, so it keeps the fail-open, type-agnostic read. */
export function transcriptOrderId(transcriptPath) {
  return String(extractValue(firstEntry(transcriptPath)?.text ?? '', 'order id') || '').trim();
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
