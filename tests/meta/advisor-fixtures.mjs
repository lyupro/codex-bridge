/** Valid advisor answers shared by the verdict and schema tests (Plan_59 D3-D5, D10). */
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
