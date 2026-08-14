import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFileSync } from '../lib/json-file.mjs';

const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');
/**
 * The file keeps its reply-guard name although two guards now share it: renaming would abandon the
 * budgets already spent on hosts in the field, and a guard that forgets its refusals starts
 * refusing the same call again.
 */
export const BLOCKED_FILE = path.join(LOG_DIR, 'codex-reply-guard.blocked.json');
export const FORM = 'form';
export const STATE = 'state';
export const MAX_FORM_BLOCKS = 3;
export const MAX_STATE_BLOCKS = 3;

const wholeCount = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

function priorCount(prior, kind) {
  if (prior && typeof prior === 'object' && !Array.isArray(prior)) {
    return wholeCount(prior[kind]);
  }
  if (kind === FORM && typeof prior === 'number') return wholeCount(prior);
  if (kind === FORM) return prior ? 1 : 0;
  return 0;
}

// Plan_31 reuses this persisted try budget so the TaskStop guard cannot grow a second,
// divergent counter beside reply-guard's existing per-agent escape hatch.
export function takeTry(agentId, kind, maxBlocks = kind === STATE ? MAX_STATE_BLOCKS : MAX_FORM_BLOCKS) {
  if (!agentId) return 'untracked';

  let seen;
  try {
    seen = readJsonFileSync(BLOCKED_FILE);
  } catch {
    seen = {};
  }
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) seen = {};

  const current = priorCount(seen[agentId], kind);
  if (current >= maxBlocks) return 'exhausted';

  const prior = seen[agentId];
  const next = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior } : {};
  next[kind] = current + 1;
  seen[agentId] = next;

  const ids = Object.keys(seen);
  if (ids.length > 200) ids.slice(0, ids.length - 200).forEach((id) => delete seen[id]);
  try {
    fs.mkdirSync(path.dirname(BLOCKED_FILE), { recursive: true });
    fs.writeFileSync(BLOCKED_FILE, `${JSON.stringify(seen)}\n`);
  } catch {
    return 'untracked';
  }
  return 'granted';
}
