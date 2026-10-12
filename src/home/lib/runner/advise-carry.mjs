/** Owns the scope snapshot shared by advise readers because run 2026-09-23_141341_plan59-a1-stdin-hang left them with different inputs. */
import { EXIT } from './exit-codes.mjs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { parseAdvisorTask } from '../meta/advisor-task.mjs';
import { die } from './args.mjs';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';

export function advisorTaskArtifact({ taskText, phase, runsRoot, grantRun }) {
  const task = parseAdvisorTask(taskText);
  if (phase !== 'advise') return task;
  if (typeof runsRoot !== 'string' || !runsRoot || typeof grantRun !== 'string' || !grantRun) {
    throw new Error(orderDiagnosticMessage('advise-scope-input-required'));
  }
  const scopeFile = path.join(runsRoot, grantRun, 'result.json');
  let result;
  try {
    result = readJsonFileSync(scopeFile);
  } catch (error) {
    throw new Error(orderDiagnosticMessage('advise-scope-result-readable', { scopeFile, message: error.message }));
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      !Array.isArray(result.predicted_risks) || !Array.isArray(result.missing_paths) ||
      result.predicted_risks.some((risk) => !risk || typeof risk.id !== 'string' || typeof risk.risk !== 'string') ||
      result.missing_paths.some((entry) => typeof entry !== 'string')) {
    throw new Error(orderDiagnosticMessage('advise-scope-result-shape', { scopeFile }));
  }
  return { ...task, scope: { run: grantRun, predicted_risks: result.predicted_risks, missing_paths: result.missing_paths } };
}

// Called before makeRunDir: a scope result that cannot be carried is known before any quota is
// spent, so it refuses like every other preflight gate instead of leaving a registered run behind.
export function advisorTaskOrRefuse(input) {
  try {
    return advisorTaskArtifact(input);
  } catch (error) {
    return die([error.message, orderDiagnosticMessage('run-not-created')].join(' '), EXIT.FAIL);
  }
}

export function adviseSection(artifact) {
  if (!artifact?.scope) return String();
  const lines = [
    '## Scope phase results',
    '',
    'Predicted risks:',
    ...artifact.scope.predicted_risks.map(({ id, risk }) => `- ${id}: ${risk}`),
    '',
    'Paths you may additionally read and cite:',
    ...artifact.scope.missing_paths.map((entry) => `- ${entry}`),
  ];
  return lines.join('\n');
}
