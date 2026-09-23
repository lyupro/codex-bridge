/** Valid advisor answers shared by the verdict and schema tests (Plan_59 D3-D5, D10). */
import fs from 'node:fs';
import path from 'node:path';

export function validAdvice() {
  return {
    recommendation: { option_id: 'keep', text: 'Keep the current boundary.' },
    unlisted_option: 'none',
    why: ['The entry point is explicit at src/entry.mjs:1.', 'The second line is stable.', 'No caller migration is needed.'],
    rejected: [{ option_id: 'split', cost: 'Requires a coordinated caller migration.' }],
    strongest_counterargument: 'The existing boundary may retain coupling as more callers arrive, requiring a later coordinated migration.',
    question_defect: 'none',
    assumptions: ['VERIFIED', 'REASONABLE', 'FRAGILE'].map((rating) => ({ claim: 'The caller uses this boundary.', rating, address: rating === 'VERIFIED' ? 'src/entry.mjs:1' : '' })),
    risk_outcomes: ['r1', 'r2', 'r3'].map((risk_id, index) => ({ risk_id, outcome: index === 1 ? 'refuted' : 'confirmed', address: 'src/entry.mjs:1' })),
    pre_mortem: [
      { scenario: 'A new caller requiring separate lifecycle ownership would overturn this decision.', early_check: { kind: 'inspect', target: 'src/entry.mjs:1' } },
      { scenario: 'Concurrent callers could share mutable state and corrupt their independent results.', early_check: { kind: 'test', target: 'caller isolation' } },
    ],
    open_questions: ['Which callers need separate ownership?', 'Which constraints remain uncertain?'],
    confidence: 'medium',
    independent_checks: [{ check: 'Read the entry point.', address: 'src/entry.mjs:1-3' }],
  };
}

export function validScope() {
  return {
    sufficient: true, missing_paths: [], taken_on_trust: ['The supplied requirements describe the intended caller.'],
    predicted_risks: ['r1', 'r2', 'r3'].map((id) => ({ id, risk: 'Concurrent callers could share mutable state.' })),
  };
}

/**
 * The facts the advisor judge reads from a run folder beyond the result: the parsed task the
 * launcher wrote and the repository its addresses resolve in. The run folder doubles as that
 * repository, so `result.json` is the one listed path.
 */
export function advisorRunFacts(dir, phase = 'scope') {
  const scope = validScope();
  fs.writeFileSync(path.join(dir, 'advisor-task.json'), JSON.stringify({
    options: [{ id: 'keep', description: 'Keep the boundary.' }, { id: 'split', description: 'Split it.' }],
    paths: ['result.json'],
    ...(phase === 'advise' ? { scope: { run: 'scope', predicted_risks: scope.predicted_risks, missing_paths: scope.missing_paths } } : {}),
  }));
  const statusFile = path.join(dir, 'status.json');
  const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
  fs.writeFileSync(statusFile, JSON.stringify({ ...status, phase, repo: dir }));
  return dir;
}
