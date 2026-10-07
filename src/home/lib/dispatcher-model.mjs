/** records which model family each dispatcher type actually ran on, against the installed contract
 * Plan_67 D4 observes every assistant model at stop; D5 compares families; D10 does not infer host precedence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readDispatcherPin } from './dispatcher-pin.mjs';
import { parseJsonText } from './json-file.mjs';
import { compareModelFamilies } from './model-family.mjs';
import { normalizeLedger, readLedgerFile, recordObservation } from './observation-ledger.mjs';

export const DISPATCHER_MODEL_FILE = 'dispatcher-model.json';

export function transcriptModels(transcriptPath) {
  let source;
  try {
    source = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const models = [];
  let complete = true;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = parseJsonText(transcriptPath, line);
    } catch {
      complete = false;
      continue;
    }
    if (record?.type !== 'assistant' && record?.message?.role !== 'assistant') continue;
    if (typeof record.message?.model === 'string') models.push(record.message.model);
  }
  return { models, complete };
}

export function modelObservation({ agentType, hostVersion, pin, models, complete = true }) {
  const comparison = compareModelFamilies({ pinFamily: pin.family, modelIds: models ?? [] });
  const { parsed, unparsed } = comparison;
  // Plan_67 D8: a partial transcript cannot establish recovery, but can still prove a violation.
  const incompleteMatch = comparison.verdict === 'match' && complete !== true;
  const verdict = incompleteMatch ? 'undetermined' : comparison.verdict;
  const data = {
    hostVersion: hostVersion ?? null, agentType, pinFamily: pin.family,
    parsed, unparsed, comparison: 'installed-contract',
    ...(pin.family === null ? { pinReasons: pin.reasons } : {}),
    ...(incompleteMatch ? { complete: false } : {}),
  };
  const detail = verdict === 'violation'
    ? `${agentType} ran on ${parsed.join(', ')} while the installed contract pins ${pin.family}`
    : verdict === 'match'
      ? `${agentType} ran on ${parsed.join(', ')} matching the installed contract pin ${pin.family}`
      : incompleteMatch
        ? `${agentType} model comparison is undetermined: the transcript has unreadable records`
        : `${agentType} model comparison against the installed contract is undetermined`;
  return { key: `${hostVersion || 'unknown'}|${agentType}`, verdict, detail, data };
}

function normalizeDispatcherModel(parsed) {
  const ledger = normalizeLedger(parsed);
  if (!ledger) return null;
  for (const entry of Object.values(ledger.entries)) {
    for (const observation of [entry.lastObservation, entry.lastViolation, entry.lastMatch, ...entry.history]) {
      if (observation === null) continue;
      const data = observation.data;
      if (!data || Object.getPrototypeOf(data) !== Object.prototype
        || !(data.hostVersion === null || typeof data.hostVersion === 'string')
        || typeof data.agentType !== 'string' || data.agentType.length === 0) return null;
    }
  }
  return ledger;
}

export function readDispatcherModel({ stateDir }) {
  return readLedgerFile(path.join(stateDir, DISPATCHER_MODEL_FILE), { normalize: normalizeDispatcherModel });
}

export async function recordDispatcherModel({ stateDir, observation, now = new Date().toISOString() }) {
  return recordObservation({
    stateDir, id: 'dispatcher-model', file: path.join(stateDir, DISPATCHER_MODEL_FILE),
    observation: { ...observation, at: now },
  });
}

export function modelLatch({ ledger, agentType }) {
  let violation = null;
  let matchSeq = 0;
  // D8: seq, rather than timestamps or host versions, decides recovery across hosts of this type.
  for (const entry of Object.values(ledger?.entries ?? {})) {
    if (entry.lastViolation?.data?.agentType === agentType
      && entry.lastViolation.seq > (violation?.seq ?? 0)) violation = entry.lastViolation;
    if (entry.lastMatch?.data?.agentType === agentType) matchSeq = Math.max(matchSeq, entry.lastMatch.seq);
  }
  return { active: violation !== null && violation.seq > matchSeq, violation };
}

export async function observeDispatcherModelStop({ brandRoot, stateDir, input, hostVersion }) {
  const transcript = transcriptModels(input.agent_transcript_path);
  const observation = modelObservation({
    agentType: input.agent_type, hostVersion,
    pin: readDispatcherPin({ brandRoot, agentType: input.agent_type }),
    models: transcript?.models ?? null, complete: transcript?.complete === true,
  });
  try {
    await recordDispatcherModel({ stateDir, observation });
  } catch {
    // D4: a diagnostic write failure must not block the stop or hide an observed quota violation.
  }
  return observation.verdict === 'violation'
    ? `codex-bridge: dispatcher ${input.agent_type} ran on ${observation.data.parsed.join(', ')} while the installed contract pins ${observation.data.pinFamily} — Claude quota was spent on it; run codex-bridge doctor.`
    : null;
}
