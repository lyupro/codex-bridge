/**
 * Judges whether a recorded run is still live and what state its artifacts support.
 *
 * Plan_57 D27 centralizes this rule after reply-guard's bare-pid check mistook a reused
 * Windows pid for a live run, while the project list printed `running` for a dead run.
 * Requiring the run folder keeps identity and artifact evidence in every judgment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { heartbeatAge } from '../heartbeat.mjs';
import {
  IDENTITY_ALIVE,
  IDENTITY_DEAD,
  IDENTITY_FOREIGN,
  IDENTITY_UNVERIFIED,
  processIdentity,
} from '../process-identity.mjs';
import { readJson } from './paths.mjs';

export function runLiveness({ runDir, status, ...identityOptions }) {
  if (typeof runDir !== 'string' || !runDir.trim()) {
    throw new TypeError('runLiveness requires a non-empty runDir string');
  }
  if (status === undefined) status = readJson(path.join(runDir, 'status.json'));
  const recordedState = status && typeof status === 'object' && typeof status.state === 'string'
    ? status.state
    : null;
  const heartbeatAgeMs = heartbeatAge(runDir, identityOptions.now);
  if (recordedState !== 'running') {
    return { recordedState, identity: null, processMayBeAlive: null, heartbeatAgeMs, state: recordedState };
  }

  const identity = processIdentity({ runDir, status, ...identityOptions });
  // Fail open: treating an unverified process as dead could close a live run and make
  // markAbandoned a second writer of its meta.json, or let another paid run write into
  // the same tree (the 2026-08-05 incident). Only a known-dead writer permits either.
  const processMayBeAlive = identity === IDENTITY_ALIVE || identity === IDENTITY_UNVERIFIED;
  let state = identity === IDENTITY_ALIVE ? 'running' : 'unverified';
  if (identity === IDENTITY_DEAD || identity === IDENTITY_FOREIGN) {
    const metaPath = path.join(runDir, 'meta.json');
    const meta = readJson(metaPath);
    state = meta ? 'finished' : fs.existsSync(metaPath) ? 'unverified' : 'abandoned';
  }
  return { recordedState, identity, processMayBeAlive, heartbeatAgeMs, state };
}
