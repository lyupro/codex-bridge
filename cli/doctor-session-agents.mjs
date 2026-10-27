/**
 * Reports which witnessed Claude Code sessions loaded the bridge dispatchers.
 * OW-071: on 2026-10-21 doctor reported matching files while a window had not loaded them.
 * Only proven absence warrants a restart warning; unreadable listings cannot prove a broken session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../src/home/lib/agents.mjs';
import { dispatcherPresence, sessionAgentTypes } from '../src/home/lib/agent-listing.mjs';
import { LOAD_WITNESS_FILE, readLoadWitness } from '../src/home/lib/load-witness.mjs';
import { check } from './doctor-format.mjs';

// Operator decision 2026-10-27: doctor runs only by hand.
const TRANSCRIPT_WINDOW_MS = 9 * 24 * 60 * 60 * 1000;

export async function sessionAgentsCheck({ stateDir, readListing = sessionAgentTypes, stat = fs.statSync, now = Date.now() }) {
  let witness;
  try {
    witness = readLoadWitness({ stateDir });
  } catch {
    return check('sessionAgents', 'warn', 'load witness could not be read');
  }
  if (witness.corrupt) {
    return check('sessionAgents', 'warn', `load witness is unreadable: ${path.join(stateDir, LOAD_WITNESS_FILE)}`);
  }
  const sessions = Object.entries(witness.sessions);
  if (!sessions.length) return check('sessionAgents', 'warn', 'no recorded session yet');

  const listings = [];
  let notVerifiable = 0;
  let skipped = 0;
  const cutoff = now - TRANSCRIPT_WINDOW_MS;
  for (const [sessionId, session] of sessions) {
    try {
      if (typeof session?.transcriptPath !== 'string') {
        skipped++;
        continue;
      }
      try {
        if (stat(session.transcriptPath).mtimeMs < cutoff) {
          skipped++;
          continue;
        }
      } catch {
        skipped++;
        continue;
      }
      const listing = await readListing({ transcriptPath: session.transcriptPath, sessionId });
      const presence = Object.keys(AGENTS).map((name) => [name, dispatcherPresence(listing, name)]);
      if (presence.some(([, state]) => state === 'unknown')) {
        notVerifiable++;
        continue;
      }
      listings.push({ sessionId, cwd: session.cwd, observedAt: listing.observedAt,
        missing: presence.filter(([, state]) => state === 'absent').map(([name]) => name) });
    } catch {
      // OW-071: one lost transcript must not hide proven absence in another session.
      notVerifiable++;
    }
  }
  listings.sort((a, b) => (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0));
  const absent = listings.filter((listing) => listing.missing.length);
  const scope = `transcript modified within the last 9 days: ${listings.length - absent.length} verified complete; `
    + `${notVerifiable} not verifiable; ${skipped} skipped (older than 9 days or transcript unavailable; not assessed)`;
  if (absent.length) {
    const details = absent.map(({ sessionId, cwd, observedAt, missing }) =>
      `${sessionId.slice(0, 8)}${typeof cwd === 'string' && cwd ? ` (${cwd})` : ''}`
      + ` listing ${observedAt ?? 'time unavailable'}: missing ${missing.join(', ')}`);
    return check('sessionAgents', 'warn',
      `${details.join('; ')}; restart that window if it is still open; ${scope}`);
  }
  if (listings.length + notVerifiable === 0) {
    return check('sessionAgents', 'warn', `no sessions were assessed; ${scope}`);
  }
  return check('sessionAgents', 'ok', scope);
}
