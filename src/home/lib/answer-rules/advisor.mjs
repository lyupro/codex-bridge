/** OW-068 / Plan_80 E21: advisor answer policy shared by prompt statements and rejection reasons. */
export const UNLISTED_OPTION_MIN_CHARS = 40;
export const BACKSTOPS = Object.freeze({
  English: Object.freeze(['both options are good', 'it depends on preference', 'you know better', 'either works']),
  Russian: Object.freeze(['оба варианта хороши', 'зависит от предпочтений', 'вам виднее', 'подойдёт любой']),
});

const BOTH = Object.freeze(['scope', 'advise']);
const SCOPE = Object.freeze(['scope']);
const ADVISE = Object.freeze(['advise']);

export const RULES = Object.freeze({
  'advisor-citation-path': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Use a non-empty repository-relative file path in every evidence location and path:line or path:line-line citation.',
    message: ({ field, label }) => `D3 ${field} ${JSON.stringify(label)}: use a repository-relative path:line or path:line-line address.`,
    data: Object.freeze(['field', 'label']),
  }),
  'advisor-citation-existing-file': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Cite an existing file under repoRoot, never a directory, absolute path or path escaping repoRoot, including through a symlink.',
    message: ({ field, label }) => `D3 ${field} ${JSON.stringify(label)}: cite an existing file under repoRoot.`,
    data: Object.freeze(['field', 'label']),
  }),
  'advisor-citation-readable-file': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Cite only files whose contents can be read under repoRoot.',
    message: ({ field, label }) => `D3 ${field} ${JSON.stringify(label)}: cite a readable file under repoRoot.`,
    data: Object.freeze(['field', 'label']),
  }),
  'advisor-citation-line-range': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Use safe integer line numbers in ascending order: line_start must be at least 1, line_end must be at least line_start and at or before the file\'s last line; an empty file has no valid line range.',
    message: ({ field, label, count }) => `D3 ${field} ${JSON.stringify(label)}: use an ascending line range within this file's ${count} lines.`,
    data: Object.freeze(['field', 'label', 'count']),
  }),
  'advisor-citation-allowed-path': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Cite only a task path or a file within a listed task directory, or a missing_paths entry or its directory contents from this scope answer (scope phase) or the supplied scope result (advise phase).',
    message: ({ field, label }) => `D3 ${field} ${JSON.stringify(label)}: cite a task path or a scope missing_paths entry.`,
    data: Object.freeze(['field', 'label']),
  }),
  'advisor-prose-address': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Write prose code addresses as repository-relative path:line or path:line-line, including quoted addresses; addresses with a slash or backslash, or a bare name resolving to an existing root file, are checked throughout text fields except structured evidence and early_check.target.',
    message: ({ field, label }) => `D3 ${field} ${JSON.stringify(label)}: use a repository-relative path:line or path:line-line address.`,
    data: Object.freeze(['field', 'label']),
  }),
  'advisor-verified-evidence': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'For every assumption rated VERIFIED, provide at least one location in its evidence array.',
    message: ({ index }) => `D10 assumptions[${index}].evidence []: a VERIFIED assumption needs at least one location.`,
    data: Object.freeze(['index']),
  }),
  'advisor-inspect-evidence': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'For every pre_mortem early_check whose kind is inspect, provide at least one location in early_check.evidence.',
    message: ({ index }) => `D10 pre_mortem[${index}].early_check.evidence []: an inspect check needs at least one location.`,
    data: Object.freeze(['index']),
  }),
  'advisor-control-character': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Exclude control characters U+0000 through U+0008, U+000B, U+000C and U+000E through U+001F from every text field.',
    message: ({ field, codePoint }) => `integrity ${field}: remove control character ${codePoint}.`,
    data: Object.freeze(['field', 'codePoint']),
  }),
  'advisor-lone-surrogate': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Exclude unpaired UTF-16 surrogates from every text field: each high surrogate U+D800–U+DBFF must be followed by a low surrogate U+DC00–U+DFFF, and each low surrogate must be preceded by a high surrogate.',
    message: ({ field, codePoint }) => `integrity ${field}: remove lone surrogate ${codePoint}.`,
    data: Object.freeze(['field', 'codePoint']),
  }),
  'advisor-commands-run': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Run at least one command to inspect repository evidence before answering.',
    message: () => 'D4 commandsRun 0: inspect repository evidence before answering.',
    data: Object.freeze([]),
  }),
  'advisor-taken-on-trust': Object.freeze({
    phases: SCOPE,
    when: 'always',
    rule: 'Include at least one assumption in taken_on_trust.',
    message: () => 'D4 taken_on_trust []: name at least one assumption taken on trust.',
    data: Object.freeze([]),
  }),
  'advisor-insufficient-missing-paths': Object.freeze({
    phases: SCOPE,
    when: 'always',
    rule: 'When sufficient is false, include at least one path needed for advice in missing_paths.',
    message: () => 'D4 missing_paths [] with sufficient false: name the paths needed for advice.',
    data: Object.freeze([]),
  }),
  'advisor-sufficient-missing-paths': Object.freeze({
    phases: SCOPE,
    when: 'always',
    rule: 'When sufficient is true, leave missing_paths empty.',
    message: ({ missingPaths }) => `D4 missing_paths ${JSON.stringify(missingPaths)} with sufficient true: resolve the scope contradiction.`,
    data: Object.freeze(['missingPaths']),
  }),
  'advisor-unique-risk-id': Object.freeze({
    phases: SCOPE,
    when: 'always',
    rule: 'Use a distinct id for each predicted_risks entry; no predicted risk id may repeat.',
    message: ({ index, id }) => `D10 predicted_risks[${index}].id ${JSON.stringify(id)}: use a unique predicted risk id.`,
    data: Object.freeze(['index', 'id']),
  }),
  'advisor-recommendation-option-id': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'Set recommendation.option_id to an id from the task options or exactly none-of-these.',
    message: ({ optionId }) => `D5 recommendation.option_id ${JSON.stringify(optionId)}: choose a task option id.`,
    data: Object.freeze(['optionId']),
  }),
  'advisor-unlisted-option-length': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: `When recommending none-of-these, describe unlisted_option in at least ${UNLISTED_OPTION_MIN_CHARS} Unicode code points after trimming leading and trailing whitespace; the literal "none" is not a description.`,
    message: ({ unlistedOption }) => `D10 unlisted_option ${JSON.stringify(unlistedOption)}: describe an unlisted option in at least ${UNLISTED_OPTION_MIN_CHARS} characters.`,
    data: Object.freeze(['unlistedOption']),
  }),
  'advisor-reject-all-options': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'When recommending none-of-these, include every task option id in rejected.',
    message: ({ missing }) => `D10 rejected ${JSON.stringify(missing)}: reject every task option when recommending "none-of-these".`,
    data: Object.freeze(['missing']),
  }),
  'advisor-listed-option-none': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'When recommending a listed task option, set unlisted_option to exactly "none".',
    message: ({ unlistedOption }) => `D10 unlisted_option ${JSON.stringify(unlistedOption)}: use "none" when recommending a task option.`,
    data: Object.freeze(['unlistedOption']),
  }),
  'advisor-rejected-option-id': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'Use only ids from the task options in each rejected entry\'s option_id.',
    message: ({ index, optionId }) => `D5 rejected[${index}].option_id ${JSON.stringify(optionId)}: use a task option id.`,
    data: Object.freeze(['index', 'optionId']),
  }),
  'advisor-reject-recommended-option': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'Do not include recommendation.option_id in rejected.',
    message: ({ index, optionId }) => `D5 rejected[${index}].option_id ${JSON.stringify(optionId)}: do not reject the recommended option.`,
    data: Object.freeze(['index', 'optionId']),
  }),
  'advisor-risk-outcome-id': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'When a scope result is supplied, use only its predicted_risks ids as risk_outcomes risk_id values.',
    message: ({ index, riskId }) => `D10 risk_outcomes[${index}].risk_id ${JSON.stringify(riskId)}: use a scope predicted risk id.`,
    data: Object.freeze(['index', 'riskId']),
  }),
  'advisor-one-outcome-per-risk': Object.freeze({
    phases: ADVISE,
    when: 'always',
    rule: 'When a scope result is supplied, provide exactly one risk_outcomes entry per scope predicted risk id, without omissions or duplicates.',
    message: ({ riskId, count }) => `D10 risk_outcomes ${JSON.stringify(riskId)} count ${count}: provide exactly one outcome per predicted risk.`,
    data: Object.freeze(['riskId', 'count']),
  }),
  'advisor-backstop-phrase': Object.freeze({
    phases: BOTH,
    when: 'always',
    rule: 'Replace backstop phrases with a decision in every text field: ' +
      Object.entries(BACKSTOPS).map(([language, phrases]) => `${language}: ${phrases.map((phrase) => `"${phrase}"`).join(', ')}`).join('; ') +
      '; the judge checks the answer language\'s list (both lists for another language), normalizes text with Unicode NFKC and matches ignoring case, allowing punctuation or symbols between letters within words and one or more whitespace, punctuation or symbol characters between words, with no adjacent letter or number at either phrase boundary.',
    message: ({ field, match, phrase }) => `D5 ${field} ${JSON.stringify(match)}: replace backstop phrase ${JSON.stringify(phrase)} with a decision.`,
    data: Object.freeze(['field', 'match', 'phrase']),
  }),
});
