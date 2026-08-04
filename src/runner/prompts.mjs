/**
 * What each agent is told to do, one instruction text per agent.
 *
 * These are data, not comments: the wording IS the contract a run is graded against, and
 * every rule in it was added by an incident. Keyed by agent name, next to the matching
 * schema in schemas.mjs — one lookup picks both halves of an agent's strategy.
 */
import { DEFAULTS } from '../run-config.mjs';
import { RUN_ENV } from './run-env.mjs';
const BODIES = {
  'codex-scout': (opts, scope, questions = []) => `Response rules:
- You are working in read-only mode: do not try to write or edit anything.
- Answer from your own reading: do not spawn or delegate to other agents.
- The response is an analysis, not a map. Explain in prose: how it works, which fields,
  signatures, and contracts are involved, how the areas differ, and what follows from this.
  A list of coordinates instead of an analysis does NOT count and will be rejected as empty.
- Coordinates in \`path:line\` form belong in evidence, not in place of the response: each
  response needs at least one reference. If removing paths and coordinates leaves no several
  sentences of coherent text, there is no response.
${
  questions.length
    ? `- The sub-questions are listed above. Each Q1..Q${questions.length} needs its own object in
  answers: question_id, a separate analysis in answer, and its own references in evidence.
  One common response to all sub-questions is not acceptable — a missed sub-question fails the run.
- The top-level answer is a 2-4 sentence summary of the whole task, on top of the analyses.`
    : `- Put one object in answers with question_id "Q1": analysis in answer, references in evidence.
- The top-level answer is the same response summarized in 2-4 sentences.`
}
- Base the response on what you read; support every fact with a \`path:line\` reference in where.
- If facts are missing, list them in unknowns; do not make them up.
- report_markdown is a full markdown report with sections: “Response” (2-4 sentences),
  “How it works” (required: prose analysis ${questions.length ? 'for each sub-question' : 'of the mechanism'},
  grounded in the code), “Findings” (fact / location / confidence table), “Missing information”.`,
  'codex-build': (opts) => `Definition of done: exactly as stated in the task above.

Working rules:
- Change only what the task requires. Do not refactor adjacent code or reformat files.
- Prefer the smallest correct change and the patterns this project already uses over new
  abstractions of your own.
- Do this work yourself: do not spawn or delegate to other agents. Their edits would land in
  this worktree as yours, outside the scope you are graded against. If the task needs authority
  you do not have, or a file is being changed by someone else, put that in leftovers.
- Work strictly within the scope from the section above. Do not touch a file outside the list
  under any circumstances — even if it blocks you, looks broken, or is a “one-line fix”. Put the
  obstacle in leftovers. Touched files are checked against the worktree scope after the run,
  and an out-of-scope change fails the entire run.
- Do not commit or prepare a commit: \`git commit\`, \`git add\`, \`git stash\`, new branches and
  tags, and any changes inside \`.git/\` are prohibited. The orchestrator performs acceptance
  and commits; it must see your changes uncommitted. If a commit seems unavoidable, put that
  in leftovers instead of running a command. A changed HEAD fails the run.
- Do not leave stubs, TODOs, \`test.skip\`/\`.only\`, or unimplemented branches. If something
  cannot be done, do not pretend it is done; list it in leftovers.
- After making changes, run verification: ${opts.verify || 'determine the command from the project'}.
  Put the command actually run in verify_command and whether it passed in verify_passed.
- Declare the outcome in outcome: "done" if the work the task asked for was carried out,
  "fail" if it was not — for any reason at all, including an impossible order, a file that
  does not exist, a scope that forbids the only fix, or running out of time. "done" with an
  empty changes[] is correct only when the task asked you to check something and nothing
  needed changing; if you could not do what was asked, "fail" is the answer even when the
  worktree is clean and verification is green. This is not a self-grade: work that was done
  and merely leaves follow-ups is "done" with the follow-ups in leftovers, and partial work
  that satisfies the definition of done is "done" too. On "fail" the first sentence of summary
  states the reason — it is what the orchestrator is shown.
- summary and changes describe only changes in this repository for this task. Do not include
  anything unrelated in them.
- Each change is a separate changes[] entry, exactly one file per entry. The file field contains
  one repository-root-relative path exactly as git prints it. Globs (\`*\`, \`?\`), brace expansion
  (\`dir/{a,b}.ts\`), and lists separated by \`;\` or \`,\` are prohibited: a collapsed entry will
  match no file when the report is checked against the worktree and will fail the run even if
  the work was done honestly.
- Do not fix the environment. Service directories (\`.omx/\`, \`.claude/\`, \`.codex/\`, \`.git/\`,
  \`node_modules/\`) and other sessions are not your task, even if they prevent you from working
  or finishing. Put the obstacle in leftovers instead of changing them.
- report_markdown is a full markdown report with sections: “What was done”, “Changes”
  (file / what changed / why table), “Verification” (command and its actual output),
  “Remaining work / risks”.`,
  'codex-review': (opts, scope) => `Review the changes as an independent second opinion. The author is another AI model.

Review scope: ${scope.label}
Get the exact diff with: ${scope.diffCommand}
Affected files:
${scope.files.length ? scope.files.map((f) => `- ${f}`).join('\n') : '- (empty: git showed no changes in this scope)'}

Priorities, in order: correctness bugs, security holes, data loss, broken error handling,
race conditions, silently swallowed failures, unimplemented branches left as stubs.

Rules:
- Review it yourself: do not spawn or delegate to other agents.
- Report only defects you can point at with file and line numbers.
- Do not report style preferences, formatting, or naming unless they change meaning.
- Do not invent problems to look useful. An empty findings list is a valid answer.
- Set confidence honestly: "low" when you are guessing about intent or missing context.`,
};

/**
 * The language of the answer, appended to every agent rather than repeated in three places.
 * Left unsaid, the model picked it from the task, the surrounding docs or its own default: an
 * English order once came back in Russian, and one project's artifacts ended up in two languages.
 */
const languageRule = () =>
  `- Write the answer, report_markdown and every text field of result.json in ` +
  `${RUN_ENV?.answerLanguage || DEFAULTS.answerLanguage}, whatever language the task is written in.`;

export const INSTRUCTIONS = Object.fromEntries(
  Object.entries(BODIES).map(([agent, body]) => [agent, (...args) => `${body(...args)}\n${languageRule()}`]),
);
