/** Parses blind advisor task choices so Plan_59 D5 rejects biased or ambiguous inputs before review. */
import { orderRuleMessage } from '../order-rules.mjs';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';

const OPTION = /^\s*-\s+([a-z0-9][a-z0-9-]*):\s*(.*)$/;
const PREFERENCE = /recommend|prefer|рекоменд|предпочт|\(✓\)|★/iu;

function sections(text) {
  if (typeof text !== 'string') throw new TypeError(orderDiagnosticMessage('advisor-task-text-required'));
  const found = { options: { header: null, lines: [] }, paths: { header: null, lines: [] } };
  let current = null;
  for (const [index, value] of text.split(/\r\n|\n|\r/).entries()) {
    const line = { number: index + 1, value };
    const heading = value.match(/^\s{0,3}(#{1,2})\s+(.+?)\s*$/);
    if (heading) {
      const name = heading[2].replace(/\s+#+$/, '').toLowerCase();
      current = heading[1] === '##' && Object.hasOwn(found, name) ? found[name] : null;
      if (current && !current.header) current.header = line;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return found;
}

function optionsFrom(lines) {
  return lines.flatMap(({ value }) => {
    const match = value.match(OPTION);
    return match ? [{ id: match[1], description: match[2].trim() }] : [];
  });
}

function pathsFrom(lines) {
  return lines.flatMap(({ value }) => {
    const match = value.match(/^\s*-\s+(.+?)\s*$/);
    return match && match[1].trim() ? [match[1].trim()] : [];
  });
}

export function parseAdvisorTask(text) {
  const { options, paths } = sections(text);
  return { options: optionsFrom(options.lines), paths: pathsFrom(paths.lines) };
}

export function advisorTaskRefusal(text) {
  const { options, paths } = sections(text);
  if (!options.header) return orderRuleMessage('advisor-task-options', { violation: 'missing' });
  const ids = new Set();
  for (const line of options.lines) {
    const preference = line.value.match(PREFERENCE);
    if (preference) {
      return orderRuleMessage('advisor-task-options', {
        violation: 'preference', lineNo: line.number, line: line.value, preference: preference[0],
      });
    }
    if (!/^\s*[-*+](?:\s|$)/.test(line.value)) continue;
    const match = line.value.match(OPTION);
    if (!match) {
      return orderRuleMessage('advisor-task-options', {
        violation: 'option-shape', lineNo: line.number, line: line.value,
      });
    }
    if (ids.has(match[1])) return orderRuleMessage('advisor-task-options', {
      violation: 'duplicate', lineNo: line.number, line: line.value, optionId: match[1],
    });
    ids.add(match[1]);
  }
  if (ids.size < 2) return orderRuleMessage('advisor-task-options', {
    violation: 'too-few', lineNo: options.header.number, line: options.header.value,
  });
  if (!paths.header) return orderRuleMessage('advisor-task-paths', { violation: 'missing' });
  if (!pathsFrom(paths.lines).length) {
    return orderRuleMessage('advisor-task-paths', {
      violation: 'empty', lineNo: paths.header.number, line: paths.header.value,
    });
  }
  return null;
}
