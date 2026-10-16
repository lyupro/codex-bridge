/**
 * Lays out a resume run from the named run's frozen inputs and states its worker order
 * (Plan_80 E13/O6). The original task is preserved, not sent again: resending it would
 * restart the work that the resumed thread exists to continue.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { resumeArgs } from './codex-args.mjs';
import { resumePrompt } from './prompts.mjs';

const ARTIFACT_NAMES = new Set([
  'task-original.md', 'schema.json', 'questions.json', 'advisor-task.json', 'scope.txt',
]);

export function resumeSituationKind(namedRunDir) {
  try {
    const meta = readJsonFileSync(path.join(namedRunDir, 'meta.json'));
    const kind = meta?.situation?.kind;
    if (typeof kind === 'string' && /^[a-z][a-z-]*$/.test(kind)) return kind;
  } catch {
    // Legacy runs may lack readable stop metadata; the continuation still needs a kind.
  }
  return 'evidence-unknown';
}

export function writeResumeArtifacts({ runDir, inputs, situationKind, note }) {
  if (typeof note !== 'string' || !note.trim()) {
    throw new TypeError('Resume requires a non-empty note.');
  }
  const entries = Object.entries(inputs.files);
  if (entries.some(([name]) => !ARTIFACT_NAMES.has(name)) ||
      !Object.hasOwn(inputs.files, 'task-original.md') ||
      !Object.hasOwn(inputs.files, 'schema.json')) {
    throw new TypeError('Resume requires original task and schema with only known artifact names.');
  }
  const prompt = resumePrompt(situationKind);
  for (const [name, text] of entries) {
    fs.writeFileSync(path.join(runDir, name), text, 'utf8');
  }
  fs.writeFileSync(path.join(runDir, 'task.md'), prompt, 'utf8');
  fs.writeFileSync(path.join(runDir, 'resume-note.md'), note, 'utf8');
}

export function resumeWorkerFields({ inputs, runDir, resumedFrom }) {
  return {
    args: resumeArgs({
      agent: inputs.agent, profile: inputs.profile, threadId: inputs.thread_id, runDir,
    }),
    profile: inputs.profile,
    resume: {
      thread_id: inputs.thread_id,
      resumed_from: resumedFrom,
      sandbox_mode: 'read-only',
    },
  };
}
