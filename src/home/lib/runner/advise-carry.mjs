/** Owns the scope snapshot shared by advise readers because run 2026-09-23_141341_plan59-a1-stdin-hang left them with different inputs. */
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { parseAdvisorTask } from '../meta/advisor-task.mjs';
import { die } from './args.mjs';

export function advisorTaskArtifact({ taskText, phase, runsRoot, grantRun }) {
  const task = parseAdvisorTask(taskText);
  if (phase !== 'advise') return task;
  if (typeof runsRoot !== 'string' || !runsRoot || typeof grantRun !== 'string' || !grantRun) {
    throw new Error('Cannot carry advise scope result: runsRoot and grantRun are required.');
  }
  const scopeFile = path.join(runsRoot, grantRun, 'result.json');
  let result;
  try {
    result = readJsonFileSync(scopeFile);
  } catch (error) {
    throw new Error(`Cannot read advise scope result at ${scopeFile}: ${error.message}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      !Array.isArray(result.predicted_risks) || !Array.isArray(result.missing_paths) ||
      result.predicted_risks.some((risk) => !risk || typeof risk.id !== 'string' || typeof risk.risk !== 'string') ||
      result.missing_paths.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Malformed advise scope result at ${scopeFile}: expected predicted_risks and missing_paths arrays.`);
  }
  return { ...task, scope: { run: grantRun, predicted_risks: result.predicted_risks, missing_paths: result.missing_paths } };
}

// Called before makeRunDir: a scope result that cannot be carried is known before any quota is
// spent, so it refuses like every other preflight gate instead of leaving a registered run behind.
export function advisorTaskOrRefuse(input) {
  try {
    return advisorTaskArtifact(input);
  } catch (error) {
    return die(`${error.message} The run folder was not created; quota was not spent.`, 1);
  }
}

export function adviseSection(artifact) {
  if (!artifact?.scope) return '';
  return [
    '## Scope phase results',
    '',
    'Predicted risks:',
    ...artifact.scope.predicted_risks.map(({ id, risk }) => `- ${id}: ${risk}`),
    '',
    'Paths you may additionally read and cite:',
    ...artifact.scope.missing_paths.map((entry) => `- ${entry}`),
  ].join('\n');
}
