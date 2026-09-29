/**
 * Decides what a help request is and how one command's help reads (Plan_71 D1).
 * `codex-bridge model -h` answered "unexpected argument" and no subcommand answered -h at all
 * (2026-09-29), so the operator could not learn how to set a model. Only exact argv shapes count
 * (advice A1): a scan for --help would turn `--host --help` — today a "requires a value" refusal —
 * into a help answer and hide the parser's error.
 */

export function helpRequest(argv, actions = []) {
  const isHelp = (value) => value === '-h' || value === '--help';
  if (argv.length === 1 && isHelp(argv[0])) return { action: null };
  if (argv.length === 2 && actions.includes(argv[0]) && isHelp(argv[1])) {
    return { action: argv[0] };
  }
  return null;
}

export function withCommandHelp(command, message) {
  const hint = `Run codex-bridge ${command} -h for usage.`;
  if (message === hint || message.endsWith(`\n${hint}`)) return message;
  return `${message}\n${hint}`;
}

export function renderCommandHelp(entry, action = null) {
  const prefix = `codex-bridge ${entry.name}`;
  const actions = Object.entries(entry.actions ?? {});
  // Registry typos must fail even when the malformed action is not the requested one.
  for (const section of [entry, ...actions.map(([, details]) => details)]) {
    for (const line of section.usage) {
      if (line !== prefix && !line.startsWith(`${prefix} `)) {
        throw new Error(`Help usage must start with "${prefix}": ${line}`);
      }
    }
  }

  let section = entry;
  if (action !== null) {
    const match = actions.find(([name]) => name === action);
    if (!match) throw new Error(`Unknown help action for ${entry.name}: ${action}`);
    section = match[1];
  }
  const lines = ['Usage:', ...section.usage.map((line) => `  ${line}`), '', section.summary];
  if (action === null && entry.actions) {
    const width = Math.max(...actions.map(([name]) => name.length));
    lines.push('', 'Actions:', ...actions.map(([name, details]) => `  ${name.padEnd(width)}  ${details.summary}`));
    lines.push(`Run codex-bridge ${entry.name} <action> -h for one action.`);
  }
  return lines.join('\n');
}
