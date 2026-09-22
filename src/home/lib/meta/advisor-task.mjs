/** Parses blind advisor task choices so Plan_59 D5 rejects biased or ambiguous inputs before review. */
const OPTION = /^\s*-\s+([a-z0-9][a-z0-9-]*):\s*(.*)$/;
const PREFERENCE = /recommend|prefer|рекоменд|предпочт|\(✓\)|★/iu;

function sections(text) {
  if (typeof text !== 'string') throw new TypeError('Advisor task text must be a string.');
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

function at(line) {
  return `line ${line.number} ${JSON.stringify(line.value)}`;
}

export function advisorTaskRefusal(text) {
  const { options, paths } = sections(text);
  if (!options.header) return 'Options: add a "## Options" section with at least two options.';
  const ids = new Set();
  for (const line of options.lines) {
    const preference = line.value.match(PREFERENCE);
    if (preference) {
      return `Options ${at(line)}: remove preference marker ${JSON.stringify(preference[0])} (D5).`;
    }
    if (!/^\s*[-*+](?:\s|$)/.test(line.value)) continue;
    const match = line.value.match(OPTION);
    if (!match) {
      return `Options ${at(line)}: use "- option-id: description" with id matching [a-z0-9][a-z0-9-]*.`;
    }
    if (ids.has(match[1])) return `Options ${at(line)}: replace duplicate option id "${match[1]}".`;
    ids.add(match[1]);
  }
  if (ids.size < 2) return `Options ${at(options.header)}: provide at least two distinct options.`;
  if (!paths.header) return 'Paths: add a "## Paths" section with repository-relative paths.';
  if (!pathsFrom(paths.lines).length) {
    return `Paths ${at(paths.header)}: add at least one repository-relative path as a list item.`;
  }
  return null;
}
