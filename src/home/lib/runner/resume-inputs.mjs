/**
 * Reads and validates a named run's frozen inputs so a resume replays them instead of
 * regenerating them from current files or configuration (Plan_80 E13/O3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText, readJsonFileSync } from '../json-file.mjs';
import { readEvents } from '../meta/events.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export function readResumeInputs(runDir) {
  let status;
  try {
    status = readJsonFileSync(path.join(runDir, 'status.json'));
  } catch {
    return { ok: false, reasons: ['status-unreadable'] };
  }

  const reasons = [];
  if (['agent', 'order_id', 'phase', 'repo', 'task_hash'].some((key) => !nonEmpty(status?.[key]))) {
    reasons.push('status-incomplete');
  }

  let profile;
  try {
    const worker = readJsonFileSync(path.join(runDir, 'worker.json'));
    profile = worker?.profile;
    if (!isObject(profile)) reasons.push('profile-missing');
  } catch {
    reasons.push('worker-order-unreadable');
  }

  const thread_id = readEvents(runDir).session_id;
  if (!nonEmpty(thread_id)) reasons.push('thread-unavailable');
  let meta;
  try {
    meta = readJsonFileSync(path.join(runDir, 'meta.json'));
  } catch {
    // Plan_80 E13/O3: metadata is optional; only a recorded thread disagreement refuses replay.
  }
  if (nonEmpty(meta?.session_id) && meta.session_id !== thread_id) reasons.push('thread-mismatch');

  const originalTask = fs.existsSync(path.join(runDir, 'task-original.md')) ? 'task-original.md' : 'task.md';
  const artifacts = [
    { name: originalTask, destination: 'task-original.md' },
    { name: 'schema.json', json: true },
  ];
  if (status?.agent === 'codex-scout') artifacts.push({ name: 'questions.json', json: true, shape: Array.isArray });
  if (status?.agent === 'codex-advisor' && status.phase === 'advise') {
    artifacts.push({ name: 'advisor-task.json', json: true, shape: isObject });
  }
  if (status?.agent === 'codex-review') artifacts.push({ name: 'scope.txt' });

  const files = {};
  for (const { name, destination = name, json, shape } of artifacts) {
    const file = path.join(runDir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      reasons.push(`artifact-missing:${name}`);
      continue;
    }
    if (json) {
      try {
        const value = parseJsonText(file, raw);
        if (shape && !shape(value)) throw new Error('Invalid artifact shape');
      } catch {
        reasons.push(`artifact-malformed:${name}`);
        continue;
      }
    }
    files[destination] = raw;
  }

  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    inputs: {
      agent: status.agent,
      phase: status.phase,
      slug: status.slug,
      order_id: status.order_id,
      repo: status.repo,
      task_hash: status.task_hash,
      task_hash_scheme: status.task_hash_scheme,
      continued_from: status.continued_from ?? null,
      profile,
      thread_id,
      files,
    },
  };
}
