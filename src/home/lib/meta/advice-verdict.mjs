/** Judges advisor evidence and independent decisions so Plan_59 D3/D4/D5/D10 failures cannot pass as advice. */
import fs from 'node:fs';
import path from 'node:path';
import { answerRuleMessage } from '../answer-rules.mjs';
import { BACKSTOPS, UNLISTED_OPTION_MIN_CHARS } from '../answer-rules/advisor.mjs';

const reason = (key, values = {}) => answerRuleMessage('codex-advisor', key, values);
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

// Plan_68 D7: `<anything>:<digits>` is not evidence of intent. On 2026-09-28 the prose "so 00:05 under
// yesterday's log" failed a complete advise run as file `00`, line 5 — a lost pass of the quota. A left side
// with a directory is always a claim and stays strict; a bare name is one only when that root file exists,
// so times, ratios and host:port pass while package.json and Makefile keep the read boundary. No extension
// test: `api.example.com:443` would fail as a file. The accepted cost — an invented bare name is not caught.
function isCitationInProse(address, root) {
  const file = address.match(/^(.+):\d+(?:-\d+)?$/)?.[1];
  return file !== undefined && (/[\\/]/.test(file) || entryInRepo(root, file)?.isFile === true);
}

function citationProblem(file, start, end, root, allowed) {
  if (typeof file !== 'string' || !file) return { key: 'advisor-citation-path', values: {} };
  const entry = entryInRepo(root, file);
  if (!entry?.isFile) return { key: 'advisor-citation-existing-file', values: {} };
  let count;
  try {
    count = lineCount(entry.absolute);
  } catch {
    return { key: 'advisor-citation-readable-file', values: {} };
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > count) {
    return { key: 'advisor-citation-line-range', values: { count } };
  }
  if (!allowed.some((scope) => entry.relative === scope.relative ||
    (scope.isDirectory && (!scope.relative || entry.relative.startsWith(`${scope.relative}/`))))) {
    return { key: 'advisor-citation-allowed-path', values: {} };
  }
  return null;
}

function checkCitations({ phase, result, task, repoRoot, scopeResult }, reasons) {
  const root = path.resolve(repoRoot);
  const allowed = [...task.paths, ...(phase === 'scope' ? result.missing_paths : scopeResult?.missing_paths ?? [])]
    .map((raw) => entryInRepo(root, raw)).filter(Boolean);
  const locationLabel = ({ file, line_start, line_end }) =>
    `${file}:${line_start}${line_end === line_start ? '' : `-${line_end}`}`;
  const checkLocation = (field, location) => {
    const { file, line_start: start, line_end: end } = location;
    const label = locationLabel(location);
    const problem = citationProblem(file, start, end, root, allowed);
    if (problem) reasons.push(reason(problem.key, { field, label, ...problem.values }));
  };
  const checkAddress = (field, raw) => {
    const match = raw.match(/^(.+):(\d+)(?:-(\d+))?$/);
    if (!match) {
      reasons.push(reason('advisor-prose-address', { field, label: raw }));
      return;
    }
    const start = Number(match[2]);
    checkLocation(field, {
      file: match[1],
      line_start: start,
      line_end: match[3] === undefined ? start : Number(match[3]),
    });
  };
  // D3 covers every address anywhere in the answer. A list of prose fields had to be edited by
  // hand when `falsifier` became `pre_mortem`, and each new field would have joined it unchecked.
  // Structured evidence and the free-text early_check.target are handled separately below.
  for (const { field, value } of strings(result)) {
    if (/(?:^|\.)evidence(?:\[|\.|$)|\.early_check\.target$/.test(field)) continue;
    for (const address of addressesIn(value, root)) {
      if (isCitationInProse(address, root)) checkAddress(field, address);
    }
  }
  const checkEvidence = (field, evidence) => {
    for (const [index, location] of evidence.entries()) checkLocation(`${field}[${index}]`, location);
  };
  if (result.independent_checks) {
    for (const [index, item] of result.independent_checks.entries()) {
      checkEvidence(`independent_checks[${index}].evidence`, item.evidence);
    }
  }
  if (phase === 'advise') {
    for (const [index, item] of result.assumptions.entries()) {
      if (item.rating === 'VERIFIED' && item.evidence.length === 0) {
        reasons.push(reason('advisor-verified-evidence', { index }));
      }
      checkEvidence(`assumptions[${index}].evidence`, item.evidence);
    }
    for (const [index, item] of result.pre_mortem.entries()) {
      const { early_check: earlyCheck } = item;
      if (earlyCheck.kind === 'inspect' && earlyCheck.evidence.length === 0) {
        reasons.push(reason('advisor-inspect-evidence', { index }));
      }
      checkEvidence(`pre_mortem[${index}].early_check.evidence`, earlyCheck.evidence);
    }
    // A risk outcome's locations are evidence whether or not the phase-1 answer is at hand.
    for (const [index, item] of result.risk_outcomes.entries()) {
      checkEvidence(`risk_outcomes[${index}].evidence`, item.evidence);
    }
  }
}

// Plan_68 D6: on 2026-09-27 an advise answer cut by the schema ended in U+0000 and passed as OK.
// This is integrity, not completeness: a cut that ends on a whole character is not detectable here,
// which is why the cause — the hidden length cap — was removed from the schema instead.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const codePoint = (char) => `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

function integrityProblems(result, reasons) {
  for (const { field, value } of strings(result)) {
    const control = value.match(CONTROL)?.[0];
    const surrogate = value.match(LONE_SURROGATE)?.[0];
    if (control) reasons.push(reason('advisor-control-character', { field, codePoint: codePoint(control) }));
    else if (surrogate) reasons.push(reason('advisor-lone-surrogate', { field, codePoint: codePoint(surrogate) }));
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
  integrityProblems(result, reasons);
  if (commandsRun === 0) reasons.push(reason('advisor-commands-run'));
  if (phase === 'scope') {
    if (!result.taken_on_trust.length) {
      reasons.push(reason('advisor-taken-on-trust'));
    }
    if (result.sufficient === false && !result.missing_paths.length) {
      reasons.push(reason('advisor-insufficient-missing-paths'));
    }
    if (result.sufficient === true && result.missing_paths.length) {
      reasons.push(reason('advisor-sufficient-missing-paths', { missingPaths: result.missing_paths }));
    }
    const riskIds = new Set();
    for (const [index, item] of result.predicted_risks.entries()) {
      if (riskIds.has(item.id)) {
        reasons.push(reason('advisor-unique-risk-id', { index, id: item.id }));
      }
      riskIds.add(item.id);
    }
  } else {
    const ids = new Set(task.options.map(({ id }) => id));
    const chosen = result.recommendation.option_id;
    if (!ids.has(chosen) && chosen !== 'none-of-these') {
      reasons.push(reason('advisor-recommendation-option-id', { optionId: chosen }));
    }
    if (chosen === 'none-of-these') {
      if (result.unlisted_option === 'none' || [...result.unlisted_option.trim()].length < UNLISTED_OPTION_MIN_CHARS) {
        reasons.push(reason('advisor-unlisted-option-length', { unlistedOption: result.unlisted_option }));
      }
      const rejected = new Set(result.rejected.map(({ option_id }) => option_id));
      const missing = [...ids].filter((id) => !rejected.has(id));
      if (missing.length) {
        reasons.push(reason('advisor-reject-all-options', { missing }));
      }
    } else if (ids.has(chosen) && result.unlisted_option !== 'none') {
      reasons.push(reason('advisor-listed-option-none', { unlistedOption: result.unlisted_option }));
    }
    for (const [index, item] of result.rejected.entries()) {
      if (!ids.has(item.option_id)) {
        reasons.push(reason('advisor-rejected-option-id', { index, optionId: item.option_id }));
      }
      if (item.option_id === chosen) {
        reasons.push(reason('advisor-reject-recommended-option', { index, optionId: chosen }));
      }
    }
    if (scopeResult !== undefined) {
      const riskIds = new Set(scopeResult.predicted_risks.map(({ id }) => id));
      for (const [index, item] of result.risk_outcomes.entries()) {
        if (!riskIds.has(item.risk_id)) {
          reasons.push(reason('advisor-risk-outcome-id', { index, riskId: item.risk_id }));
        }
      }
      for (const id of riskIds) {
        const count = result.risk_outcomes.filter(({ risk_id }) => risk_id === id).length;
        if (count !== 1) {
          reasons.push(reason('advisor-one-outcome-per-risk', { riskId: id, count }));
        }
      }
    }
  }
  checkCitations({ phase, result, task, repoRoot, scopeResult }, reasons);
  const phrases = Object.hasOwn(BACKSTOPS, language) ? BACKSTOPS[language] : Object.values(BACKSTOPS).flat();
  const patterns = phrases.map((phrase) => [phrase, backstopPattern(phrase)]);
  for (const { field, value } of strings(result)) {
    for (const [phrase, pattern] of patterns) {
      const match = value.normalize('NFKC').match(pattern);
      if (match) {
        reasons.push(reason('advisor-backstop-phrase', { field, match: match[0], phrase }));
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}
