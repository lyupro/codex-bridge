/** Judge and report the sandbox witnessed for a resumed turn. */
import path from 'node:path';
import { line, readJson } from './paths.mjs';

export function resumeOrigin(status) {
  const resumedFrom = status?.resumed_from;
  return typeof resumedFrom === 'string' && resumedFrom.trim() && !/[/\\]/.test(resumedFrom)
    && path.win32.basename(resumedFrom) === resumedFrom && resumedFrom !== '.' && resumedFrom !== '..'
    ? resumedFrom : null;
}

export function sandboxWitnessGap(runDir) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (!resumeOrigin(status)) return null;
  const witness = status?.stop?.session?.sandbox_witness;
  if (witness?.state !== 'observed' || witness.policy === 'read-only') return null;
  return `resume turn ran with sandbox policy "${line(witness.policy, 60)}" `
    + `(session log at ${line(witness.at, 60)}), not read-only; its result is not trusted`;
}

export function sandboxWitnessRow(runDir) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (!resumeOrigin(status)) return null;
  const witness = status?.stop?.session?.sandbox_witness;
  if (witness?.state === 'observed') {
    return witness.policy === 'read-only'
      ? `Sandbox witness: read-only — session log at ${line(witness.at, 60)}`
      : `Sandbox witness: ${line(witness.policy, 60)} — not read-only; the result is not trusted`;
  }
  if (witness?.state === 'absent') {
    return 'Sandbox witness: absent — the session log records no sandbox policy for the resumed turn; read-only is not confirmed';
  }
  return 'Sandbox witness: not observed — the session log was not read to the end; read-only is not confirmed';
}
