/** OW-068 / Plan_80 E21: one registry connects catalog agents to their reason producers and branch entries. */
import fs from 'node:fs';
import { ANSWER_RULES } from '../src/home/lib/answer-rules.mjs';

export const JUDGED_AGENTS = [
  {
    agent: 'codex-advisor',
    files: [{ file: 'advice-verdict.mjs' }],
    entries: ['adviceGap'],
    emitter: null,
  },
  {
    agent: 'codex-scout',
    files: [
      { file: 'verdict.mjs', functionName: 'scoutCoverageGap' },
      { file: 'context-only.mjs', functionName: 'contextOnlyGap' },
      { file: 'execution-fact.mjs', functionName: 'scoutExecutionGap' },
    ],
    entries: ['scoutExecutionGap', 'scoutCoverageGap', 'contextOnlyGap'],
    emitter: 'scoutReason',
  },
  {
    agent: 'codex-build',
    files: [
      { file: 'verdict.mjs', functionNames: ['commitDuringRun', 'branchDuringRun', 'reportVersusWork'] },
      { file: 'outcome.mjs', functionNames: ['outcomeGap'] },
    ],
    entries: ['commitDuringRun', 'branchDuringRun', 'outcomeGap', 'reportVersusWork'],
    emitter: 'buildReason',
  },
].map((judge) => ({
  ...judge,
  catalogKeys: Object.keys(ANSWER_RULES[judge.agent]),
  files: judge.files.map((entry) => ({
    ...entry,
    source: fs.readFileSync(new URL(`../src/home/lib/meta/${entry.file}`, import.meta.url), 'utf8'),
  })),
}));

export const HOST_REASON_FUNCTIONS = Object.freeze({
  snapshotRefusal: 'snapshot comparison refusal is host evidence the model cannot satisfy (Plan_80 E21)',
});

export const HOST_REASON_SUFFIXES = Object.freeze({
  hooks: 'the hooks-enabled note appended to the build report reason is host configuration (Plan_80 E21)',
});
