/**
 * Reads the runner's structured Codex transport and turns it into facts for metadata and
 * verdicts. This is the only module that knows the file is JSONL: a model can quote a limit in
 * its own item text, but only these runner-written error events are allowed to stop a retry.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Quota exhaustion, and nothing else that merely says "limit". A bare `limit` also appears in
 * "context length limit" — an error about the content of the order, which the orchestrator is
 * supposed to fix and re-send. Calling that LIMIT would forbid the one retry that would work.
 */
const LIMIT_RE = /rate[\s_-]*limit|usage[\s_-]*limit|quota|too many requests|\b429\b/i;

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

const compact = (value, max = 300) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A broken final line is expected when the runner is stopped while Codex is writing.
 *
 * Whether the file was there at all is reported separately from what it held: a run killed
 * before the CLI said one word leaves an empty stream, and telling the operator that such a
 * run "predates the change" sends them looking for the wrong thing entirely.
 */
function readLines(runDir) {
  if (!runDir) return { exists: false, events: [] };
  let text;
  try {
    text = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    return { exists: false, events: [] };
  }
  const events = [];
  for (const raw of text.split(/\r?\n/)) {
    const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (!source.trim()) continue;
    try {
      const event = JSON.parse(source);
      if (record(event)) events.push(event);
    } catch {
      // A line cut short by MAX_LOG or a killed process is not a transport verdict.
    }
  }
  return { exists: true, events };
}

function usageOf(events) {
  const completed = events.filter((event) => event.type === 'turn.completed' && record(event.usage));
  if (!completed.length) return { tokens: null, usage: null };

  const usage = {};
  let tokens = 0;
  for (const event of completed) {
    for (const [key, value] of Object.entries(event.usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        usage[key] = (usage[key] || 0) + value;
      } else if (!(key in usage)) {
        usage[key] = value;
      }
    }
    if (typeof event.usage.input_tokens === 'number' && Number.isFinite(event.usage.input_tokens)) {
      tokens += event.usage.input_tokens;
    }
    if (typeof event.usage.output_tokens === 'number' && Number.isFinite(event.usage.output_tokens)) {
      tokens += event.usage.output_tokens;
    }
  }
  return { tokens, usage };
}

function payloadOf(event) {
  const source =
    event.type === 'error'
      ? event.message ?? event.error
      : event.error?.message ?? event.error ?? event.message;
  if (typeof source === 'string') {
    try {
      const parsed = JSON.parse(source);
      return record(parsed) ? parsed : { message: source };
    } catch {
      return { message: source };
    }
  }
  return record(source) ? source : {};
}

function transportErrorOf(event) {
  if (event.type !== 'error' && event.type !== 'turn.failed') return null;
  const payload = payloadOf(event);
  const nested = record(payload.error) ? payload.error : {};
  const errorType =
    (typeof nested.type === 'string' && nested.type) ||
    (typeof payload.type === 'string' && payload.type !== 'error' && payload.type) ||
    null;
  const message =
    (typeof nested.message === 'string' && nested.message) ||
    (typeof payload.message === 'string' && payload.message) ||
    null;
  const status = payload.status ?? nested.status ?? null;
  const marker = [errorType, message].join(' ');
  const quota = Number(status) === 429 || LIMIT_RE.test(marker);
  const reason = compact(
    [errorType, message, status === null || status === undefined ? '' : `status ${status}`]
      .filter(Boolean)
      .join(': ') ||
      (typeof event.message === 'string' ? event.message : '') ||
      (typeof event.error?.message === 'string' ? event.error.message : '') ||
      event.type,
  );
  return { event, payload, status, error_type: errorType, message, quota, reason };
}

/**
 * Reads all usable events and derives accounting without letting unreadable JSONL poison a run.
 * Numeric usage fields are summed across turns; with one turn this preserves the CLI object
 * and its fields exactly, while tokens intentionally count input plus output only.
 */
export function readEvents(runDir) {
  const { exists, events } = readLines(runDir);
  const accounting = usageOf(events);
  const started = events.find((event) => event.type === 'thread.started' && event.thread_id);
  const errors = events.map(transportErrorOf).filter(Boolean);
  const transport_error = errors.find((error) => error.quota) || errors[0] || null;
  return {
    events,
    // The file was written, whatever it holds. Pass 2 judges a run by this: a stream the
    // runner promised in its own arguments and did not leave behind is damaged evidence,
    // not an archived run.
    hasStream: exists,
    hasEvents: events.length > 0,
    tokens: accounting.tokens,
    usage: accounting.usage,
    session_id: started ? String(started.thread_id) : null,
    transport_error,
  };
}
