/** Renders a run's structured Codex transport as a readable event-by-event report. */
import { readEvents } from '../src/meta/events.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';
import { resolveRunFolder } from './run-lookup.mjs';

const result = (exitCode, output) => ({ exitCode, output });
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

const inline = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function compactJson(value, max = 300) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return inline(text, max) || '{}';
}

function itemSection(item) {
  const type = typeof item?.type === 'string' && item.type ? item.type : 'unknown item';
  if (type === 'agent_message') {
    return `${type}\n${String(item.text ?? item.message ?? '')}`.trimEnd();
  }
  if (type === 'error') {
    return `${type}\n${inline(item.message) || compactJson(item)}`;
  }
  const shortText = ['text', 'message', 'summary', 'output', 'command', 'result']
    .map((key) => item?.[key])
    .find((value) => typeof value === 'string' && value.trim());
  return `${type}\n${shortText ? inline(shortText) : compactJson(item)}`;
}

function usageSection(usage) {
  if (!record(usage)) return 'turn.completed\nUsage: unavailable';
  const numbers = Object.entries(usage)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  return `turn.completed\nUsage: ${numbers || 'unavailable'}`;
}

function serviceSection(event) {
  if (event.type === 'thread.started') {
    return `${event.type} · Thread ID: ${event.thread_id ?? 'unknown'}`;
  }
  if (event.type === 'item.started' && typeof event.item?.type === 'string' && event.item.type) {
    return `${event.type} · Item: ${event.item.type}`;
  }
  return event.type;
}

function transportSection(event, transportError) {
  const nested = record(event.error) ? event.error : {};
  const status = event.status ?? nested.status ?? nested.status_code
    ?? event.codex_error_info?.http_status ?? nested.codex_error_info?.http_status;
  const directMessage = typeof event.message === 'string'
    ? event.message
    : typeof nested.message === 'string' ? nested.message : '';
  const details = transportError?.event === event ? transportError : null;
  const message = details?.message || directMessage || details?.reason || 'unknown transport failure';
  const resolvedStatus = details?.status ?? status ?? 'unknown';
  return `${event.type}\nStatus: ${resolvedStatus}\nMessage: ${inline(message)}`;
}

function renderEvent(event, transportError) {
  switch (event.type) {
    case 'thread.started':
    case 'turn.started':
    case 'item.started':
      return serviceSection(event);
    case 'item.completed':
      return itemSection(event.item);
    case 'turn.completed':
      return usageSection(event.usage);
    case 'error':
    case 'turn.failed':
      return transportSection(event, transportError);
    default:
      // Unknown events stay visible in full: a future CLI event must never disappear silently.
      return `${String(event.type || 'unknown event')}: ${compactJson(event, Infinity)}`;
  }
}

export function read({ run, cwd = process.cwd(), runsRootPath = runsRoot() } = {}) {
  const lookup = resolveRunFolder({ command: 'read', run, cwd, runsRootPath });
  if (lookup.error) return result(1, lookup.error);

  const eventData = readEvents(lookup.runDir);
  // Two different failures, told apart because they send the operator to different places: a
  // run from before the event stream existed has no file, while a run killed before the CLI
  // spoke has an empty one. Reporting both as "predates this change" would hide the second.
  if (!eventData.hasStream) {
    return result(1, `Run ${lookup.runDir} has no events.jsonl; it predates the event stream.`);
  }
  if (!eventData.hasEvents) {
    return result(
      1,
      `Run ${lookup.runDir} has an empty events.jsonl: Codex wrote no event before the run ended.`,
    );
  }
  return result(0, eventData.events.map((event) => renderEvent(event, eventData.transport_error)).join('\n\n'));
}
