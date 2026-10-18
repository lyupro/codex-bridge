/** Judge and report the sandbox witnessed for a resumed turn. */
import path from 'node:path';
import { line, readJson } from './paths.mjs';
import { automaticChildMarker } from './pre-start.mjs';

export function resumeOrigin(status) {
  const resumedFrom = status?.resumed_from;
  return typeof resumedFrom === 'string' && resumedFrom.trim() && !/[/\\]/.test(resumedFrom)
    && path.win32.basename(resumedFrom) === resumedFrom && resumedFrom !== '.' && resumedFrom !== '..'
    ? resumedFrom : null;
}

export function sandboxWitnessGap(runDir, { resultOk } = {}) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (!resumeOrigin(status)) return null;
  const witness = status?.stop?.session?.sandbox_witness;
  if (witness?.state === 'observed' && witness.policy !== 'read-only') {
    return `resume turn ran with sandbox policy "${line(witness.policy, 60)}" `
      + `(session log at ${line(witness.at, 60)}), not read-only; its result is not trusted`;
  }
  // Plan_80 E15: nobody granted an automatic child permission to continue unconfirmed.
  if (automaticChildMarker(status) && witness?.state !== 'observed' && resultOk === true) {
    return 'automatic continuation ran without a confirmed sandbox policy '
      + `(witness: ${line(witness?.state ?? 'missing', 60)}); its result is not trusted`;
  }
  return null;
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
