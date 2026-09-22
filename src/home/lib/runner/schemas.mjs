/**
 * The shape each agent's answer must have, one JSON schema per agent.
 * Plan_59 D10 adds alternatives, rated assumptions, risk outcomes, pre-mortems and open questions.
 *
 * Handed to `codex exec --output-schema`, so a run that answers in the wrong shape is
 * rejected by Codex itself rather than discovered later by write-meta.mjs. Keyed by agent
 * next to INSTRUCTIONS in prompts.mjs: the two are the same choice made twice, and looking
 * either of them up by agent name is what keeps the three agents from drifting apart.
 */
const SCOUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'answers', 'findings', 'unknowns', 'report_markdown'],
  properties: {
    answer: { type: 'string', minLength: 1 },
    // Required, not optional: a schema that only demanded a non-empty `answer` accepted a
    // run that replied to six numbered questions with one table of coordinates. One object
    // per question, each carrying its own prose — coordinates live in `evidence`.
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question_id', 'answer', 'evidence'],
        properties: {
          question_id: { type: 'string', pattern: '^Q\\d+$' },
          answer: { type: 'string', minLength: 1 },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'where', 'confidence'],
        properties: {
          fact: { type: 'string', minLength: 1 },
          where: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    unknowns: { type: 'array', items: { type: 'string' } },
    report_markdown: { type: 'string', minLength: 1 },
  },
};

const BUILD_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'summary',
    'changes',
    'verify_command',
    'verify_passed',
    'leftovers',
    'report_markdown',
  ],
  properties: {
    // The outcome is declared, never inferred. On 2026-08-04 a build asked to fix a function
    // in a module that does not exist answered `OK — no code change was made`: every artifact
    // was well-formed, the tree was legitimately clean, and the runner has no way to know
    // whether the order required an edit. A string rather than a boolean because the set of
    // outcomes will grow (`blocked` is a candidate) and an enum extends without breaking the
    // contract. Presence of this field in the run's own schema.json is also the marker that
    // says the run was contracted to declare an outcome — see meta/outcome.mjs.
    outcome: {
      type: 'string',
      enum: ['done', 'fail'],
      description:
        'done — the work the task asked for was carried out. fail — it was not, for any ' +
        'reason at all (impossible order, missing file, blocked by scope, out of time).',
    },
    summary: { type: 'string', minLength: 1 },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'what', 'why'],
        properties: {
          // One entry, one path. As a bare non-empty string this field legitimately
          // collected `src/cost/{types,reader}.ts` and `a/*.test.ts; b/*.test.ts` — honest
          // answers to "which files", and unmatchable against the worktree, so a run that
          // really had done the work was failed for the way it described it (2026-07-31,
          // run 120340). The pattern makes the folded forms impossible instead of merely
          // discouraged: no `*`, `?`, braces, `;`, `,` or whitespace.
          file: {
            type: 'string',
            minLength: 1,
            pattern: '^[^*?{};,\\s]+$',
            description:
              'Exactly one repository-root-relative path, in the form printed by git ' +
              '(for example packages/agent-sdk/src/cost/types.ts). Globs, brace expansion, ' +
              'and lists are prohibited — use a separate entry for each file.',
          },
          what: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    verify_command: { type: ['string', 'null'] },
    verify_passed: { type: ['boolean', 'null'] },
    leftovers: { type: 'array', items: { type: 'string' } },
    report_markdown: { type: 'string', minLength: 1 },
  },
};

const REVIEW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'next_steps'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'needs-attention'] },
    summary: { type: 'string', minLength: 1 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'title',
          'body',
          'file',
          'line_start',
          'line_end',
          'confidence',
          'recommendation',
        ],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
          file: { type: 'string' },
          line_start: { type: 'integer' },
          line_end: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          recommendation: { type: 'string', minLength: 1 },
        },
      },
    },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
};

/** Plan_59: execution schemas stay static; schemaFor selects the advisor contract by phase. */
export const SCHEMAS = {
  'codex-scout': SCOUT_SCHEMA,
  'codex-build': BUILD_SCHEMA,
  'codex-review': REVIEW_SCHEMA,
};

// Plan_59 D3/D4/D5/D10 keeps the design contract separate from the existing execution roles.
export const PHASE_SCHEMAS = {
  advisor: {
    scope: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['sufficient', 'missing_paths', 'taken_on_trust', 'predicted_risks'],
      properties: {
        sufficient: { type: 'boolean' },
        missing_paths: { type: 'array', items: { type: 'string' } },
        taken_on_trust: { type: 'array', minItems: 1, items: { type: 'string' } },
        predicted_risks: {
          type: 'array',
          minItems: 3,
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'risk'],
            properties: { id: { type: 'string', pattern: '^r[1-9]$' }, risk: { type: 'string' } },
          },
        },
      },
    },
    advise: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: [
        'recommendation', 'why', 'rejected', 'strongest_counterargument', 'question_defect',
        'unlisted_option', 'assumptions', 'risk_outcomes', 'pre_mortem', 'open_questions',
        'confidence', 'independent_checks',
      ],
      properties: {
        recommendation: {
          type: 'object',
          additionalProperties: false,
          required: ['option_id', 'text'],
          properties: {
            option_id: { type: 'string' },
            text: { type: 'string', maxLength: 300, pattern: '^[^\\r\\n\\u2028\\u2029]*$' },
          },
        },
        unlisted_option: { type: 'string' },
        why: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
        rejected: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['option_id', 'cost'],
            properties: { option_id: { type: 'string' }, cost: { type: 'string' } },
          },
        },
        strongest_counterargument: { type: 'string', minLength: 80 },
        question_defect: { type: 'string' },
        assumptions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claim', 'rating', 'address'],
            properties: {
              claim: { type: 'string' },
              rating: { type: 'string', enum: ['VERIFIED', 'REASONABLE', 'FRAGILE'] },
              address: { type: 'string' },
            },
          },
        },
        risk_outcomes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['risk_id', 'outcome', 'address'],
            properties: {
              risk_id: { type: 'string' },
              outcome: { type: 'string', enum: ['confirmed', 'refuted'] },
              address: { type: 'string' },
            },
          },
        },
        pre_mortem: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['scenario', 'early_check'],
            properties: {
              scenario: { type: 'string', minLength: 30 },
              early_check: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'target'],
                properties: {
                  kind: { type: 'string', enum: ['test', 'command', 'inspect'] },
                  target: { type: 'string', minLength: 3 },
                },
              },
            },
          },
        },
        open_questions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        independent_checks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['check', 'address'],
            properties: { check: { type: 'string' }, address: { type: 'string' } },
          },
        },
      },
    },
  },
};

// Plan_59: an advisor's phase, not its agent name alone, defines the answer contract.
export function schemaFor(agent, phase) {
  return agent === 'codex-advisor' ? advisorSchema(phase) : SCHEMAS[agent];
}

export function advisorSchema(phase) {
  if (!Object.hasOwn(PHASE_SCHEMAS.advisor, phase)) {
    throw new RangeError(`Unknown advisor phase ${JSON.stringify(phase)}; use "scope" or "advise".`);
  }
  return PHASE_SCHEMAS.advisor[phase];
}
