/** Converts a finished advisor run into judge inputs because schemas accept well-formed agreement; Plan_59 D3/D4/D5/D10 require the judge to reject it. */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../run-config.mjs';
import { judgeAdvice } from './advice-verdict.mjs';
import { readJson } from './paths.mjs';

function contractReason(reasons) {
  const message = `advice contract broken (${reasons.length}): ${reasons.slice(0, 2).join('; ')}`;
  return message.length <= 200 ? message : `${message.slice(0, 197)}...`;
}

export function adviceGap(runDir, result, eventData) {
  const worker = readJson(path.join(runDir, 'worker.json')) || {};
  const status = readJson(path.join(runDir, 'status.json')) || {};
  const env = readJson(path.join(runDir, 'env.json')) || {};
  const phase = worker.phase ?? status.phase;
  const taskFile = path.join(runDir, 'advisor-task.json');
  const task = readJson(taskFile);
  const reasons = [];

  if (!fs.existsSync(taskFile)) reasons.push('advisor-task.json is missing');
  else if (!Array.isArray(task?.options) || !Array.isArray(task?.paths)) {
    reasons.push('advisor-task.json is missing parsed options or paths');
  }
  if (phase !== 'scope' && phase !== 'advise') reasons.push('worker.json/status.json is missing a valid advisor phase');
  if (typeof status.repo !== 'string' || !status.repo) reasons.push('status.json#repo is missing');
  if (!Number.isInteger(eventData?.commands_executed) || eventData.commands_executed < 0) {
    reasons.push('eventData.commands_executed is missing or invalid');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) reasons.push('result.json is missing or is not an object');

  let scopeResult;
  if (phase === 'advise') {
    if (!task?.scope || !Array.isArray(task.scope.predicted_risks)) {
      reasons.push('advisor-task.json#scope is missing the phase-1 predicted_risks');
    } else {
      scopeResult = { predicted_risks: task.scope.predicted_risks, missing_paths: task.scope.missing_paths };
    }
  }
  if (reasons.length) return contractReason(reasons);

  try {
    const verdict = judgeAdvice({
      phase,
      result,
      task,
      repoRoot: status.repo,
      commandsRun: eventData.commands_executed,
      language: env.answerLanguage ?? DEFAULTS.answerLanguage,
      scopeResult,
    });
    return verdict.ok ? null : contractReason(verdict.reasons);
  } catch (error) {
    return contractReason([`result.json is missing required fields or has an unexpected shape (${error.message})`]);
  }
}
