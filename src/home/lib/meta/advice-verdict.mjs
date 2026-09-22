/** Judges advisor evidence and independent decisions so Plan_59 D3/D4/D5/D10 failures cannot pass as advice. */
import fs from 'node:fs';
import path from 'node:path';

const BACKSTOPS = {
  English: ['both options are good', 'it depends on preference', 'you know better', 'either works'],
  Russian: ['оба варианта хороши', 'зависит от предпочтений', 'вам виднее', 'подойдёт любой'],
};
const ADDRESS_TOKEN = /(?<![\p{L}\p{N}_./\\:~-])(?:[a-zA-Z]:)?[\p{L}\p{N}_@!$~.%+/\\-]+:\d+(?:-\d+)?(?![\p{L}\p{N}_:\d-])/gu;
const QUOTED_ADDRESS = /`([^`\r\n]+:\d+(?:-\d+)?)`|"([^"\r\n]+:\d+(?:-\d+)?)"|'([^'\r\n]+:\d+(?:-\d+)?)'/u;
const ADDRESS = new RegExp(`${QUOTED_ADDRESS.source}|(${ADDRESS_TOKEN.source})`, 'gu');

function* strings(value, field = '') {
  if (typeof value === 'string') yield { field, value };
  else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* strings(item, `${field}[${index}]`);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield* strings(item, field ? `${field}.${key}` : key);
    }
  }
}

function backstopPattern(phrase) {
  // Plan_59 D5 ignores punctuation within words as well as between words, without matching word prefixes.
  const words = phrase.split(' ').map((word) => [...word].join('[\\p{P}\\p{S}]*'));
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('[\\s\\p{P}\\p{S}]+')}(?![\\p{L}\\p{N}])`, 'iu');
}

function isInside(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function entryInRepo(root, raw) {
  const normalized = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return null;
  const absolute = path.resolve(root, normalized);
  if (!isInside(root, absolute)) return null;
  try {
    // Plan_59 D3 requires real containment: a repository symlink cannot authorize outside evidence.
    if (!isInside(fs.realpathSync(root), fs.realpathSync(absolute))) return null;
    const stat = fs.statSync(absolute);
    return {
      absolute,
      relative: path.relative(root, absolute).replace(/\\/g, '/'),
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
    };
  } catch {
    return null;
  }
}

function lineCount(absolute) {
  const text = fs.readFileSync(absolute, 'utf8');
  if (!text) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

function* addressesIn(value, root) {
  for (const match of value.matchAll(ADDRESS)) {
    const address = match.slice(1).find(Boolean);
    if (!match[4]) {
      // Plan_59 D3 must distinguish a quoted path with spaces from prose quoting several citations.
      const embedded = [...address.matchAll(ADDRESS_TOKEN)].map((token) => token[0]);
      const file = address.match(/^(.+):\d+(?:-\d+)?$/)[1];
      if (embedded.length && !entryInRepo(root, file)?.isFile &&
        (embedded.length > 1 || !/^[^\s]*[/\\]/.test(address))) {
        yield* embedded;
        continue;
      }
    }
    yield address;
  }
}

function citationProblem(raw, root, allowed) {
  const match = raw.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!match) return 'use a repository-relative path:line or path:line-line address';
  const entry = entryInRepo(root, match[1]);
  if (!entry?.isFile) return 'cite an existing file under repoRoot';
  let count;
  try {
    count = lineCount(entry.absolute);
  } catch {
    return 'cite a readable file under repoRoot';
  }
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > count) {
    return `use an ascending line range within this file's ${count} lines`;
  }
  if (!allowed.some((scope) => entry.relative === scope.relative ||
    (scope.isDirectory && (!scope.relative || entry.relative.startsWith(`${scope.relative}/`))))) {
    return 'cite a task path or a scope missing_paths entry';
  }
  return null;
}

function checkCitations({ phase, result, task, repoRoot }, reasons) {
  const root = path.resolve(repoRoot);
  const allowed = [...task.paths, ...(phase === 'scope' ? result.missing_paths : [])]
    .map((raw) => entryInRepo(root, raw)).filter(Boolean);
  const check = (field, address) => {
    const problem = citationProblem(address, root, allowed);
    if (problem) reasons.push(`D3 ${field} ${JSON.stringify(address)}: ${problem}.`);
  };
  const checkAddress = (field, raw) => {
    const trimmed = raw.trim();
    check(field, /^`.*`$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed);
  };
  // D3 covers every address anywhere in the answer. A list of prose fields had to be edited by
  // hand when `falsifier` became `pre_mortem`, and each new field would have joined it unchecked.
  // Fields that ARE an address are checked whole below, so they are skipped here.
  for (const { field, value } of strings(result)) {
    if (/\.address$|\.early_check\.target$/.test(field)) continue;
    for (const address of addressesIn(value, root)) check(field, address);
  }
  if (result.independent_checks) {
    for (const [index, item] of result.independent_checks.entries()) {
      checkAddress(`independent_checks[${index}].address`, item.address);
    }
  }
  if (phase === 'advise') {
    for (const [index, item] of result.assumptions.entries()) {
      if (item.rating === 'VERIFIED' || item.address !== '') {
        checkAddress(`assumptions[${index}].address`, item.address);
      }
    }
    for (const [index, item] of result.pre_mortem.entries()) {
      if (item.early_check.kind === 'inspect') {
        checkAddress(`pre_mortem[${index}].early_check.target`, item.early_check.target);
      }
    }
    // An outcome's address is evidence whether or not the phase-1 answer is at hand.
    for (const [index, item] of result.risk_outcomes.entries()) {
      checkAddress(`risk_outcomes[${index}].address`, item.address);
    }
  }
}

export function judgeAdvice({ phase, result, task, repoRoot, commandsRun, language, scopeResult }) {
  if (phase !== 'scope' && phase !== 'advise') throw new RangeError('phase must be "scope" or "advise".');
  if (!Number.isInteger(commandsRun) || commandsRun < 0) {
    throw new TypeError('commandsRun must be a non-negative integer.');
  }
  if (typeof language !== 'string') throw new TypeError('language must be a string.');
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repoRoot must be a non-empty path.');
  if (!result || !Array.isArray(task?.options) || !Array.isArray(task?.paths)) {
    throw new TypeError('result and a parsed advisor task are required.');
  }
  const reasons = [];
  if (commandsRun === 0) reasons.push('D4 commandsRun 0: inspect repository evidence before answering.');
  if (phase === 'scope') {
    if (!result.taken_on_trust.length) {
      reasons.push('D4 taken_on_trust []: name at least one assumption taken on trust.');
    }
    if (result.sufficient === false && !result.missing_paths.length) {
      reasons.push('D4 missing_paths [] with sufficient false: name the paths needed for advice.');
    }
    if (result.sufficient === true && result.missing_paths.length) {
      reasons.push(`D4 missing_paths ${JSON.stringify(result.missing_paths)} with sufficient true: resolve the scope contradiction.`);
    }
    const riskIds = new Set();
    for (const [index, item] of result.predicted_risks.entries()) {
      if (riskIds.has(item.id)) {
        reasons.push(`D10 predicted_risks[${index}].id ${JSON.stringify(item.id)}: use a unique predicted risk id.`);
      }
      riskIds.add(item.id);
    }
  } else {
    const ids = new Set(task.options.map(({ id }) => id));
    const chosen = result.recommendation.option_id;
    if (!ids.has(chosen) && chosen !== 'none-of-these') {
      reasons.push(`D5 recommendation.option_id ${JSON.stringify(chosen)}: choose a task option id.`);
    }
    if (chosen === 'none-of-these') {
      if (result.unlisted_option === 'none' || [...result.unlisted_option.trim()].length < 40) {
        reasons.push(`D10 unlisted_option ${JSON.stringify(result.unlisted_option)}: describe an unlisted option in at least 40 characters.`);
      }
      const rejected = new Set(result.rejected.map(({ option_id }) => option_id));
      const missing = [...ids].filter((id) => !rejected.has(id));
      if (missing.length) {
        reasons.push(`D10 rejected ${JSON.stringify(missing)}: reject every task option when recommending "none-of-these".`);
      }
    } else if (ids.has(chosen) && result.unlisted_option !== 'none') {
      reasons.push(`D10 unlisted_option ${JSON.stringify(result.unlisted_option)}: use "none" when recommending a task option.`);
    }
    for (const [index, item] of result.rejected.entries()) {
      if (!ids.has(item.option_id)) {
        reasons.push(`D5 rejected[${index}].option_id ${JSON.stringify(item.option_id)}: use a task option id.`);
      }
      if (item.option_id === chosen) {
        reasons.push(`D5 rejected[${index}].option_id ${JSON.stringify(chosen)}: do not reject the recommended option.`);
      }
    }
    if (scopeResult !== undefined) {
      const riskIds = new Set(scopeResult.predicted_risks.map(({ id }) => id));
      for (const [index, item] of result.risk_outcomes.entries()) {
        if (!riskIds.has(item.risk_id)) {
          reasons.push(`D10 risk_outcomes[${index}].risk_id ${JSON.stringify(item.risk_id)}: use a scope predicted risk id.`);
        }
      }
      for (const id of riskIds) {
        const count = result.risk_outcomes.filter(({ risk_id }) => risk_id === id).length;
        if (count !== 1) {
          reasons.push(`D10 risk_outcomes ${JSON.stringify(id)} count ${count}: provide exactly one outcome per predicted risk.`);
        }
      }
    }
  }
  checkCitations({ phase, result, task, repoRoot }, reasons);
  const phrases = Object.hasOwn(BACKSTOPS, language) ? BACKSTOPS[language] : Object.values(BACKSTOPS).flat();
  const patterns = phrases.map((phrase) => [phrase, backstopPattern(phrase)]);
  for (const { field, value } of strings(result)) {
    for (const [phrase, pattern] of patterns) {
      const match = value.normalize('NFKC').match(pattern);
      if (match) {
        reasons.push(`D5 ${field} ${JSON.stringify(match[0])}: replace backstop phrase ${JSON.stringify(phrase)} with a decision.`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}
