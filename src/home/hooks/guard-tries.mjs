import path from 'node:path';
import { BRAND_HOME, BRAND_STATE_DIR } from '../lib/brand-home.mjs';
import { createHomeWriter } from '../lib/home-write.mjs';
import { readJsonFileSync } from '../lib/json-file.mjs';

/**
 * Two guards share this budget (reply-guard and stop-guard). It lived in Claude Code's own
 * `~/.claude/logs/` until Plan_62 D14 moved package state into the brand home; the move abandons
 * budgets spent before it, which is harmless because they are keyed by agent ids that no longer run.
 */
export const BLOCKED_FILE = path.join(BRAND_STATE_DIR, 'reply-guard-tries.json');
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
    // Plan_65 B4: the budget is the registered guard-tries artifact, so purge can name and remove it.
    const writer = createHomeWriter({ root: BRAND_HOME.root });
    writer.mkdirSync('guard-tries', path.dirname(BLOCKED_FILE), { recursive: true });
    writer.writeFileSync('guard-tries', BLOCKED_FILE, `${JSON.stringify(seen)}\n`);
  } catch {
    return 'untracked';
  }
  return 'granted';
}
