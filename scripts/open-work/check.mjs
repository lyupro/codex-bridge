/**
 * Validates open-work rules and reciprocal document references, exposing them through the CLI.
 * Plan_72: 15 of 20 handoff records dropped unfinished items because open work had no single home.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../../cli/invoked-directly.mjs';
import { readRegister } from './register.mjs';

const REGISTER = 'docs/plans/open-work.md';
const WORKROOM = ['docs/plans', 'docs/checklists'];
const REQUIRED = ['состояние', 'владелец', 'источник', 'дом', 'следующий шаг'];
const KNOWN = new Set([...REQUIRED, 'блокер', 'доказательство']);
const STATES = new Set(['open', 'blocked', 'done', 'cancelled']);
const OWNERS = new Set(['агент', 'оператор']);

function markdownFiles(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(file);
  }
  return files;
}

function homePaths(value) {
  const paths = new Set();
  const prose = value.replace(/\[[^\]]*\]\((<[^>]+>|(?:[^()\r\n]|\([^()\r\n]*\))+)\)/g, (link, destination) => {
    let target = destination.trim();
    target = target.startsWith('<') ? target.slice(1, -1) : target.replace(/\s+["'].*$/, '');
    if (!/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) {
      target = target.split(/[?#]/)[0];
      try { target = decodeURIComponent(target); } catch { /* Keep malformed targets visible. */ }
      if (target.endsWith('.md')) paths.add(target);
    }
    // Link labels and remote destinations are text, not additional plain repository paths.
    return ' '.repeat(link.length);
  });
  for (const match of prose.matchAll(/(?<![\w/.:\\-])docs\/[^\s`<>()[\],;]+?\.md(?=$|[\s`<>()[\],;#?.!:])/g)) {
    paths.add(match[0]);
  }
  return paths;
}

export function validateOpenWork(root, { strict = false } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('A repository root is required');
  root = path.resolve(root);
  const violations = [];
  const report = (file, line, problem) => violations.push(`${file}:${line}: ${problem}`);
  const present = WORKROOM.map((directory) => {
    const absolute = path.join(root, directory);
    return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory();
  });
  if (!strict && present.every((exists) => !exists)) {
    return { violations, message: 'Workroom is absent; nothing was checked.' };
  }
  if (strict) {
    WORKROOM.forEach((directory, index) => {
      if (!present[index]) report(directory, 1, 'workroom folder is missing (strict mode)');
    });
  }
  const registerFile = path.join(root, REGISTER);
  if (!fs.existsSync(registerFile)) {
    report(REGISTER, 1, 'register is missing');
    return { violations, message: null };
  }

  const { items, queue } = readRegister(registerFile);
  if (!items.length) report(REGISTER, 1, 'register must contain at least one item');
  const byId = new Map();
  const states = new Map();
  for (const item of items) {
    if (byId.has(item.id)) report(REGISTER, item.line, `duplicate item id ${item.id}`);
    else byId.set(item.id, item);
    const fields = new Map();
    for (const field of item.fields) {
      if (!KNOWN.has(field.key)) report(REGISTER, field.line, `${item.id}: unknown field ${field.key}`);
      if (fields.has(field.key)) report(REGISTER, field.line, `${item.id}: repeated field ${field.key}`);
      else fields.set(field.key, field);
    }
    for (const key of REQUIRED) {
      if (!fields.get(key)?.value.trim()) {
        report(REGISTER, fields.get(key)?.line ?? item.line, `${item.id}: required field ${key} is missing or empty`);
      }
    }
    const state = fields.get('состояние')?.value.trim();
    if (fields.has('состояние') && !STATES.has(state)) {
      report(REGISTER, fields.get('состояние').line, `${item.id}: invalid состояние ${state}`);
    }
    if (!states.has(item.id)) states.set(item.id, state);
    const owner = fields.get('владелец');
    if (owner && !OWNERS.has(owner.value.trim())) {
      report(REGISTER, owner.line, `${item.id}: invalid владелец ${owner.value.trim()}`);
    }
    const evidence = state === 'blocked' ? 'блокер' : ['done', 'cancelled'].includes(state) ? 'доказательство' : null;
    if (evidence && !fields.get(evidence)?.value.trim()) {
      report(REGISTER, fields.get(evidence)?.line ?? item.line, `${item.id}: ${state} requires ${evidence}`);
    }
    const home = fields.get('дом');
    for (const source of home?.valueLines ?? []) {
      for (const target of homePaths(source.value)) {
        const absolute = target.startsWith('docs/')
          ? path.resolve(root, target) : path.resolve(root, 'docs/plans', target);
        const relative = path.relative(root, absolute);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          report(REGISTER, source.line, `${item.id}: home path is outside the repository: ${target}`);
        } else if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          report(REGISTER, source.line, `${item.id}: home file does not exist: ${target}`);
        }
      }
    }
  }

  const queued = new Set();
  for (const entry of queue) {
    if (queued.has(entry.id)) report(REGISTER, entry.line, `duplicate queue id ${entry.id}`);
    queued.add(entry.id);
    if (!byId.has(entry.id)) report(REGISTER, entry.line, `queue names unknown item ${entry.id}`);
    else if (!['open', 'blocked'].includes(states.get(entry.id))) {
      report(REGISTER, entry.line, `queue item ${entry.id} must be open or blocked`);
    }
  }

  // D1 section 5: checking only outgoing links would let a deleted row strand a plan's work.
  for (const directory of WORKROOM) {
    for (const file of markdownFiles(path.join(root, directory))) {
      if (file === registerFile) continue;
      const relative = path.relative(root, file).split(path.sep).join('/');
      for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
        for (const match of line.matchAll(/OW-\d{3,}/g)) {
          if (!byId.has(match[0])) report(relative, index + 1, `reference names unknown item ${match[0]}`);
        }
      }
    }
  }
  return { violations, message: null };
}

const scriptFile = fileURLToPath(import.meta.url);
// The one same-file judge (.claude/context/contracts.md): comparing spellings silenced every guard once.
if (isInvokedDirectly(process.argv[1], import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--strict')) throw new Error('Usage: node scripts/open-work/check.mjs [--strict]');
    const root = path.resolve(path.dirname(scriptFile), '../..');
    const result = validateOpenWork(root, { strict: args.includes('--strict') });
    for (const violation of result.violations) console.log(violation);
    if (result.message) console.log(result.message);
    process.exitCode = result.violations.length ? 1 : 0;
  } catch (error) {
    console.error(`${REGISTER}:1: ${error.message}`);
    process.exitCode = 1;
  }
}
