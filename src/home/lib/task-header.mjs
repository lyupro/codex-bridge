/**
 * Reads the orchestrator's metadata header at the top of a task file — the one place a grant or an
 * advice line may stand.
 *
 * Plan_75 D5: on 2026-10-03 20:42 wrapped prose in a task file began a line with `continue:`, and
 * the runner, which looked for grants on any line, refused the order over its own prose. Grants and
 * advice had two parsers and the task hash a third rule; this module is the single reader, and a
 * line below the header that still looks like real metadata is refused rather than silently obeyed
 * or silently ignored.
 */
import path from 'node:path';
import { splitGrantValue } from './required-inputs.mjs';

const BARE_RUN = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const MISPLACED_GRANT = /^[A-Za-z0-9._-]+(?:$| — | - |:)/;

function validateGrant(value) {
  const grant = splitGrantValue(value);
  return grant && BARE_RUN.test(grant.run)
    ? null
    : 'grant must name a bare run folder (not . or ..) and a non-placeholder reason';
}

function descriptor(label, validate, misplaced) {
  const spellings = [`${label}[ \\t]*[:=]`];
  for (const wrapper of ['\\*', '_', '`', '\\*\\*', '__']) {
    spellings.push(`${wrapper}${label}${wrapper}[ \\t]*[:=]`);
    spellings.push(`${wrapper}${label}[ \\t]*[:=]${wrapper}`);
  }
  return Object.freeze({
    label,
    validate,
    misplaced,
    shape: new RegExp(
      // Plan_75 D5: try a wrapper before treating its first star as a list marker.
      `^[ \\t]*(?:[-*][ \\t]*)??(?:${spellings.join('|')})[ \\t]*(.*?)[ \\t]*$`,
      'i',
    ),
    repairHint: `move it into the header at the top of the file, spelled ${label}: <value>; `
      + 'if it is an example, quote it with > or reword it inside a sentence',
  });
}

// Plan_75 D5, 2026-10-03 20:42: one registry prevents wrapped task prose becoming a grant.
const LABELS = Object.freeze([
  // Plan_75 D5: empty advice closes the strict header but must still explain the missing value.
  descriptor('advice', (value) => value.trim() && !/[\r\n]/.test(value)
    ? null : 'advice value must be non-empty and single line',
  (value) => !value || /^\S+$/.test(value)
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)),
  descriptor('continue', validateGrant, (value) => MISPLACED_GRANT.test(value)),
  descriptor('retry', validateGrant, (value) => MISPLACED_GRANT.test(value)),
]);

const HEADER_LINE = new RegExp(`^(${LABELS.map(({ label }) => label).join('|')}):[ \\t]*(\\S.*?)[ \\t]*$`);

export function parseTaskHeader(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const fields = {};
  const entries = [];
  const problems = [];
  let headerEnd = 0;

  for (const line of lines) {
    const match = line.match(HEADER_LINE);
    if (!match) break;
    const [, label, value] = match;
    const entry = { label, value, lineNo: headerEnd + 1, line };
    if (Object.hasOwn(fields, label)) {
      problems.push({ lineNo: entry.lineNo, line, reason: `duplicate ${label} label` });
    } else {
      fields[label] = value;
    }
    entries.push(entry);
    headerEnd++;
  }

  // Plan_75 D5: conflicting authorization is a label-presence error even if a value is invalid.
  if (Object.hasOwn(fields, 'continue') && Object.hasOwn(fields, 'retry')) {
    const conflict = entries.find(({ label }) => label === 'retry');
    problems.push({
      lineNo: conflict.lineNo,
      line: conflict.line,
      reason: 'continue and retry cannot both be present; keep exactly one grant label',
    });
  }

  let grant = null;
  let advice = null;
  for (const entry of entries) {
    const definition = LABELS.find(({ label }) => label === entry.label);
    const reason = definition.validate(entry.value);
    if (reason) {
      problems.push({ lineNo: entry.lineNo, line: entry.line, reason: `${entry.label}: ${reason}` });
    } else if (entry.value !== fields[entry.label]) {
      continue;
    } else if (entry.label === 'advice') {
      advice ??= entry.value;
    } else {
      grant ??= { kind: entry.label, ...splitGrantValue(entry.value) };
    }
  }

  // Plan_75 D5, 2026-10-03 20:42: fences are examples, not an escape from the misplaced guard.
  for (let index = headerEnd; index < lines.length; index++) {
    for (const definition of LABELS) {
      const match = lines[index].match(definition.shape);
      if (!match || !definition.misplaced(match[1])) continue;
      const reason = match[1] ? `misplaced ${definition.label} metadata`
        : `${definition.label} value must be non-empty and single line`;
      problems.push({
        lineNo: index + 1,
        line: lines[index],
        reason: `${reason}; ${definition.repairHint}`,
      });
    }
  }

  problems.sort((a, b) => a.lineNo - b.lineNo);
  return { fields, grant, advice, body: lines.slice(headerEnd).join('\n'), problems };
}

export function taskHeaderRefusal(parsed) {
  if (!parsed.problems.length) return null;
  return parsed.problems.map(({ lineNo, line, reason }) => `line ${lineNo}: ${reason}: ${line}`)
    .concat('The run folder was not created; quota was not spent.').join('\n');
}
