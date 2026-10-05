/** Reads the run identity carried between dispatcher hook boundaries. */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText } from './json-file.mjs';

/** Plan_63 D10: extracts the first run folder reported by the runner's own stdout. */
export function runnerReceipt(output) {
  if (typeof output !== 'string') return null;
  const line = output.split('\n').find((value) => value.startsWith('RUN=') || value.startsWith('ATTACH='));
  if (line === undefined) return null;
  const receiptLine = line.replace(/\r$/, '');
  const start = receiptLine.indexOf('=') + 1;
  const end = receiptLine.lastIndexOf(' order-id=');
  return end > start ? receiptLine.slice(start, end) : null;
}

/** Plan_63 D10: binds the run folder once and retains the first contradictory receipt. */
export function bindReceipt(state, folder) {
  if (folder === null) return {};
  if (state?.runReceipt == null) return { runReceipt: folder };
  // D10: both strings come from the same runner code, so exact equality is the contract.
  if (state.runReceipt === folder || state.runReceiptConflict) return {};
  return { runReceiptConflict: folder };
}

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
