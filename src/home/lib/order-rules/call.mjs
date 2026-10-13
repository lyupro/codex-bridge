/** Plan_79 D4: owns rules for the call line and the task file itself. */
export const RULES = Object.freeze({
  'task-file-path': Object.freeze({
    data: Object.freeze(['value']),
    topic: 'order',
    rule: 'The call names the task file by an absolute path to a file the orchestrator wrote with its file tool.',
    message: ({ value }) => `--task-file must be an absolute path; got ${JSON.stringify(value)}`,
  }),
  'task-body-required': Object.freeze({
    data: Object.freeze(['channel', 'taskFile']),
    topic: 'order',
    rule: 'The task file carries a non-empty body after the header and the blank line.',
    message: ({ channel, taskFile }) => {
      if (channel === 'task-file') return `task file from --task-file is empty: ${taskFile}`;
      if (channel === 'stdin') return 'task text on stdin is empty';
      throw new Error(`unknown task-body-required channel: ${channel}`);
    },
  }),
  'writing-run-exclusive': Object.freeze({
    data: Object.freeze(['run', 'activePath', 'identity']),
    topic: 'order',
    rule: 'Wait for the active writing run to finish before starting another writing run in the same working tree.',
    message: ({ run, activePath, identity }) => {
      const identityNote = identity === 'unverified' ? '; process identity could not be confirmed' : '';
      return [
        `run ${run} is already active for this repository; two writing runs in one tree are prohibited${identityNote}`,
        `Active run: ${activePath}`,
      ].join('\n');
    },
  }),
  'order-launch-exclusive': Object.freeze({
    data: Object.freeze(['variant', 'orderId', 'role', 'pid', 'acquiredAt', 'run']),
    topic: 'order',
    rule: 'Launch one run per order id at a time; repeat the same command to attach to that run.',
    message: ({ variant, orderId, role, pid, acquiredAt, run, holderDescription }) => {
      if (variant === 'holder-unverified') return 'a process that did not answer (unverified)';
      if (variant === 'holder') return `${role} pid ${pid} since ${acquiredAt}`;
      if (variant === 'busy') {
        return `order id "${orderId}" is being launched by ${holderDescription}; repeat the same command later — ` +
          'it attaches to that run instead of starting another.';
      }
      if (variant === 'race') {
        return `another launch of order id "${orderId}" registered ${run} while this one was preparing; ` +
          'repeat the same command — it attaches to that run.';
      }
      throw new Error(`unknown order-launch-exclusive variant: ${variant}`);
    },
  }),
  'agent-call-model': Object.freeze({
    data: Object.freeze(['agentType']),
    topic: 'order',
    rule: 'Call a dispatcher without model; its installed agent file owns the model.',
    message: ({ agentType }) =>
      "Order gate denied the Agent call because it passes `model`: a dispatcher's model is set in one place, "
      + `its installed agent file. Call ${agentType} without model.`,
  }),
  'agent-call-teammate': Object.freeze({
    data: Object.freeze(['field', 'agentType']),
    topic: 'order',
    rule: 'Call a dispatcher with subagent_type only, without teammate fields.',
    message: ({ field, agentType }) =>
      `Order gate denied the Agent call because it passes \`${field}\`: a dispatcher launched as a `
      + 'teammate escapes the dispatcher gate, whose agent_type becomes the teammate name. Call '
      + `${agentType} with subagent_type only, without name or team_name.`,
  }),
  'dispatcher-call-shape': Object.freeze({
    data: Object.freeze(['violation', 'label', 'first', 'line', 'sequence']),
    topic: 'order',
    rule: 'The call contains one exact task file label with a non-empty absolute path safe inside shell double quotes.',
    message: ({ violation, label, first, line, sequence }) => {
      if (violation === 'free-text') return 'not a `label: value` line; free text belongs in the task file';
      if (violation === 'empty') return `label \`${label}\` has an empty value`;
      if (violation === 'duplicate') return `label \`${label}\` is given twice (line ${first} and line ${line})`;
      if (violation === 'spelling') return `write the label exactly as \`${label}:\``;
      if (violation === 'header') {
        return `label \`${label}\` moved to the task-file header; the call is only \`task file: <absolute path>\``;
      }
      if (violation === 'missing') return `missing required label \`${label}\``;
      if (violation === 'placeholder') return `label \`${label}\` is still a placeholder`;
      if (violation === 'absolute') return 'label `task file` must be an absolute path';
      if (violation === 'unsafe') {
        return `label \`${label}\` contains ${JSON.stringify(sequence)}; put free text in the task file`;
      }
      if (violation === 'rewritten') {
        return `label \`${label}\` contains ${JSON.stringify(sequence)}, which the shell rewrites inside double quotes; `
          + 'write the path with forward slashes and without `$`';
      }
      throw new Error(`unknown dispatcher-call-shape violation: ${violation}`);
    },
  }),
  'dispatcher-task-file-help': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'The orchestrator writes the task file verbatim with its file tool and supplies its absolute path.',
    message: () => 'Absolute path to a file holding the task statement verbatim, written by the orchestrator with its file tool. The dispatcher passes the path to the runner and never creates, reads or rewrites the file: writing it from the shell reintroduces the permission prompt this file channel exists to remove. Given no path, return the refusal.',
  }),
  'dispatcher-call-refusal': Object.freeze({
    data: Object.freeze(['part', 'line', 'text', 'label', 'example']),
    topic: 'order',
    rule: 'The Agent call text is only `task file: <absolute path>`; every order label goes in the task-file header ' +
      'and free text in the task file body.',
    message: ({ part, line, text, label, example, reason, detail, explanation, reasons }) => {
      if (part === 'intro') return 'Order gate denied the Agent call: the call text must be only `label: value` lines.';
      if (part === 'detail') return ` — ${explanation} Example: \`${label}: ${example}\`.`;
      if (part === 'problem') return `- ${reason}${detail}`;
      if (part === 'line') return `- line ${line}: \`${text}\` — ${reason}`;
      if (part === 'call') return 'The call is only `task file: <absolute path>`.';
      if (part === 'header') return 'The order goes in the header at the top of that file:';
      if (part === 'free-text') return 'Free text belongs in the task file.';
      if (part === 'command-line') return `line ${line}: ${reason}`;
      if (part === 'command') return `the call text must be only label: value lines: ${reasons}`;
      throw new Error(`unknown dispatcher-call-refusal part: ${part}`);
    },
  }),
  'dispatcher-call-summary': Object.freeze({
    data: Object.freeze(['variant', 'required', 'conditional', 'optional']),
    topic: 'order',
    rule: 'Each dispatcher description names the header labels its task file requires, the conditional ones ' +
      'with their condition, and the optional ones.',
    message: ({ variant, required, conditional, optional }) => {
      if (variant === 'unknown-agent') return '';
      if (variant === 'labels') {
        return `The call is only \`task file\` (an absolute path). The task-file header requires ${required.join(', ')}; `
          + `conditional labels: ${conditional.join(', ')}; optional labels: ${optional.join(', ')}. `
          + 'Free text belongs in the task file.';
      }
      throw new Error(`unknown dispatcher-call-summary variant: ${variant}`);
    },
  }),
});
