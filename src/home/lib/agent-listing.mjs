/**
 * Replays a session's agent listing from its transcript without side effects.
 * OW-071: on 2026-10-21 the bridge dispatchers appeared only in a later delta.
 * Absence must be proven, never inferred: a false refusal would block every order of a healthy session.
 */
import fs from 'node:fs';
import { parseJsonText } from './json-file.mjs';

const unknown = reason => ({ state: 'unknown', reason });
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');

/** The stat dependency, like readFile, can be injected for bounded, deterministic reads. */
export function sessionAgentTypes(options) {
  try {
    const {
      transcriptPath, sessionId, readFile = fs.readFileSync, stat = fs.statSync,
      maxBytes = 64 * 1024 * 1024,
    } = options ?? {};
    if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return unknown('invalid-transcript-path');
    if (typeof sessionId !== 'string' || !sessionId.trim()) return unknown('invalid-session-id');
    if (!Number.isFinite(maxBytes) || maxBytes < 0) return unknown('invalid-max-bytes');

    let text;
    try {
      if (stat(transcriptPath).size > maxBytes) return unknown('file-too-large');
      const content = readFile(transcriptPath, 'utf8');
      if (typeof content !== 'string' && !Buffer.isBuffer(content)) return unknown('unreadable-file');
      if (Buffer.byteLength(content) > maxBytes) return unknown('file-too-large');
      text = content.toString('utf8');
    } catch {
      return unknown('unreadable-file');
    }

    const lines = text.split(/\r?\n/);
    let types = new Set();
    let records = 0;
    let observedAt;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      let entry;
      try {
        entry = parseJsonText(transcriptPath, line);
      } catch {
        // OW-071: a torn final write is harmless; a lost middle delta prevents proof of absence.
        if (line.includes('agent_listing_delta') && index !== lines.length - 1) {
          return unknown('malformed-listing-json');
        }
        continue;
      }
      if (entry?.sessionId !== sessionId || entry?.type !== 'attachment'
        || entry?.attachment?.type !== 'agent_listing_delta') continue;
      const { addedTypes, removedTypes, isInitial } = entry.attachment;
      if (!stringArray(addedTypes) || !stringArray(removedTypes) || typeof isInitial !== 'boolean') {
        return unknown('invalid-listing-record');
      }
      if (!isInitial && records === 0) return unknown('non-initial-before-initial');
      if (isInitial) types = new Set(addedTypes);
      for (const type of addedTypes) types.add(type);
      for (const type of removedTypes) types.delete(type);
      records++;
      observedAt = entry.timestamp;
    }
    if (records === 0) return unknown('no-listing-record');
    return { state: 'known', types: Object.freeze([...types].sort()), records, observedAt };
  } catch {
    return unknown('reader-error');
  }
}

export function dispatcherPresence(listing, agentType) {
  if (listing?.state !== 'known') return 'unknown';
  return listing.types.includes(agentType) ? 'present' : 'absent';
}
