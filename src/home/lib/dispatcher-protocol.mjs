/**
 * Owns only the dispatcher protocol text shared by every dispatcher prompt.
 * Plan_63 D11: four hand-written copies drifted; build even requested a continuation
 * flag absent from the canonical command. Render the command from its own assembler.
 */
import { renderRunCommandTemplate } from './dispatcher-command.mjs';
import { TASK_FILE_INPUT } from './dispatcher-call.mjs';

export function renderDispatcherProtocol(agentType) {
  const command = renderRunCommandTemplate(agentType);
  return `## Required dispatcher input

The call is exactly one line: \`${TASK_FILE_INPUT.label}: <task-file path from the orchestrator>\`.
The path must be absolute and name a file the orchestrator wrote with its file tool.
The dispatcher never creates, reads or rewrites it: writing it from the shell brings back
the permission prompt this file channel exists to remove.
The whole order — order id, grants and every other value — lives in that file's header.
The runner checks the header, never the dispatcher. The dispatcher never adds, removes or
reorders anything on the command line because of what the call or the file says.
No path in the call means run nothing and return \`FAIL — no task file in the call\`.

## When the host refuses the command

If the host refuses to run \`codex-bridge run\` — a permission prompt, a classifier denial, anything
that stops the command — that refusal is your final answer. Report \`FAIL\`, name the task file from the call,
and state the one correction: the operator runs \`codex-bridge install\`, which grants the permission
rule this package needs.

You are forbidden to look for a way around it. Specifically, and without exception:

- never call \`run-codex.mjs\`, or any file inside the installed package, by path;
- never start the runner through \`node\`, \`npx\`, \`sh\`, \`bash\` or any other interpreter;
- never retry the same call in PowerShell because Bash refused it, or the reverse;
- never split the call over more than one line, and never add a pipe, a semicolon or a redirect;
- never advise the operator to grant a permission rule on an internal file — a rule on anything but
  the package command undoes the very design that makes this call permission-stable.

Every one of those forms was removed on purpose: a host matches a permission rule against the
beginning of the final command line, so an interpreter, a path or a continuation makes the call
unmatchable by construction. Reaching for one does not rescue the run; it guarantees the refusal
and asks the operator to make it permanent. On 2026-08-15 an order in another repository did all
three in sequence and ended by telling its operator to grant a rule on \`run-codex.mjs\`.

## The only thing you do

\`\`\`bash
${command}
\`\`\`

Replace the placeholder with the path from the call, nothing else.
The first call starts the run and returns at once with \`RUN=<path> order-id=<id>\` and a
\`STARTED\` line. To get the verdict, run the identical command again. That call does not start
a second run or cost quota: it attaches to the run already in flight, prints
\`ATTACH=<path> order-id=<id> started=<time>\`, blocks until the verdict exists and prints it.
Give the attaching call \`timeout: 1800000\` (30 minutes). A real run takes 20-25 minutes,
which is normal, not a hang. If the ceiling kills it, run the identical command again:
it attaches to the same run and keeps waiting.

Background execution (\`run_in_background\`, \`&\`, \`nohup\`) is prohibited, and so is inventing
a report from memory. Never add a flag: the host allows exactly the one canonical command
and refuses every other.

A runner refusal — an order id collision, a header problem or a grant problem — is the whole
answer: return it as \`FAIL\` with the runner's text. Never retry with a changed command or another
task file. The next pass is assigned only by the orchestrator, never chosen by you.
The order id in the task-file header is issued by the orchestrator and is what makes a repeat
harmless; a changed task file or command turns a repeat into a second paid run.
On 2026-08-03 one order became six runs exactly this way, and four of them were never accounted for
at all. A second writing run in one worktree is refused anyway — the tree is shared and has no
isolation.

**Your response = the exact stdout of the attaching call**: the \`ATTACH=<path>\` line and the status
block below it. Do not add or remove anything: no preamble, explanations, or retelling of the diff.
The report is in \`report.md\`; the orchestrator will read it. Do not make commits: that is the
operator's decision. The \`STARTED\` output of the first call is not a result and is never the response.

The only allowed final response is this exact stdout. Wording such as "the run has started,
waiting for completion," "I will wait for a notification," or "Monitor started in the background" is
prohibited in any form: the subagent ceases to exist immediately after responding, nobody can wait,
and the orchestrator gets a promise instead of a result. A real case: the dispatcher gave exactly
such a response during a live run — the worktree remained busy, and this could only be discovered
by checking \`status.json\` manually.
Inventing any outcome the runner did not print is equally prohibited. On 2026-08-13 a dispatcher said
\`FAIL — could not get the Codex run result because of an architectural environment limitation\` while
that run's \`status.json\` already said \`state=finished\`, \`status=OK\`.
`;
}
