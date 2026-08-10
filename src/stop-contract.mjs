export const STOP_COMMAND = 'codex-bridge stop';
export const STOP_COMMAND_TEMPLATE = `${STOP_COMMAND} <run>`;
export const STOP_REASON =
  'TaskStop removes the wrapper while the run keeps writing to the worktree.';

export function renderStopCommand(run) {
  if (typeof run !== 'string' || !run.trim()) {
    throw new TypeError('A run folder name is required to render the stop command.');
  }
  return `${STOP_COMMAND} ${run.trim()}`;
}

export function renderStopSummary() {
  return `Stop live runs with \`${STOP_COMMAND_TEMPLATE}\` before \`TaskStop\`: ${STOP_REASON}`;
}
