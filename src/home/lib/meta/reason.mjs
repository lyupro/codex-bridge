/**
 * Resolves the ordered reason for a failed run.
 *
 * The 2026-08-05 live probe showed that stderr can contain policy noise during a healthy run,
 * so diagnostic text is the final fallback rather than the primary verdict evidence.
 */
import path from 'node:path';
import { contentErrorOf } from './events.mjs';
import { line, readText } from './paths.mjs';

/** Keeps the archived stderr heuristic intact for runs without a useful event message. */
const stderrReason = (runDir) => {
  const stderr = readText(path.join(runDir, 'stderr.log'));
  const messages = [...stderr.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  if (messages.length) return line(messages[messages.length - 1][1].replace(/\\"/g, '"'));
  const lines = stderr.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((value) => /error|failed|denied|refused/i.test(value));
  return line(errorLine || lines[lines.length - 1] || '');
};

// eventData is required, not defaulted: a caller that forgets it would silently fall back to
// stderr — the exact behaviour this module was written to replace, and a default would hide it.
export function reasonFrom(runDir, eventData) {
  const content = line(eventData.content_error ?? contentErrorOf(eventData.events || []));
  if (content) return content;
  const transport = line(eventData.transport_error?.reason || eventData.transport_error?.message);
  if (transport) return transport;
  return stderrReason(runDir);
}
