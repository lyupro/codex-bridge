/**
 * The shape each agent's answer must have, one JSON schema per agent.
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

/** Same three keys as AGENTS in write-meta.mjs; parseArgs() has already refused anything else. */
export const SCHEMAS = {
  'codex-scout': SCOUT_SCHEMA,
  'codex-build': BUILD_SCHEMA,
  'codex-review': REVIEW_SCHEMA,
};
