/** Audits dispatcher tool calls because SubagentHandback delivers the answer before SubagentStop can block it. */
import fs from 'node:fs';
import { parseJsonText } from './json-file.mjs';
import { HANDBACK_TOOL } from './hook-definitions.mjs';

export function transcriptToolUses(transcriptPath) {
  let source;
  try {
    source = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const toolUses = [];
  let complete = true;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = parseJsonText(transcriptPath, line);
    } catch {
      complete = false;
      continue;
    }
    if (record?.type !== 'assistant' && record?.message?.role !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const toolUse = { id: block.id, name: block.name };
        if (block.name === 'Bash' && typeof block.input?.command === 'string') {
          toolUse.command = block.input.command;
        }
        toolUses.push(toolUse);
      }
    }
  }
  return { toolUses, complete };
}

export function decideDispatcherStop({ state, toolUses }) {
  const seenToolUseIds = !state?.corrupt && Array.isArray(state?.seenToolUseIds)
    ? state.seenToolUseIds
    : [];
  const unseen = toolUses === null || (!state?.corrupt && state?.auditAlarmed)
    ? []
    : toolUses.filter((toolUse) => !seenToolUseIds.includes(toolUse.id));
  const handbackAttempted = (state?.handbackAttempts ?? 0) >= 1
    || toolUses?.some((toolUse) => toolUse.name === HANDBACK_TOOL) === true;

  let route;
  if (state?.handback === 'delivered') route = 'yield';
  else if (handbackAttempted && state?.stopDemanded !== true) route = 'demand';
  else if (handbackAttempted) route = 'yield';
  else route = 'legacy';

  const stateUpdate = {};
  if (route === 'demand') stateUpdate.stopDemanded = true;
  if (unseen.length) stateUpdate.auditAlarmed = true;
  return { route, unseen, stateUpdate: Object.keys(stateUpdate).length ? stateUpdate : null };
}
