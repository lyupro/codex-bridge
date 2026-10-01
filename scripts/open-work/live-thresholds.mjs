/**
 * Checks pending live-step release thresholds and their exact open-work holds without I/O.
 * Plan_72 R3 B1: releases 0.6.3…0.6.8 passed unnoticed while live steps still waited for them;
 * on 2026-10-01 fifteen checklist-index lines were overdue.
 */
const VERSION = /^\d+\.\d+\.\d+$/;
const STEP = /^\d+[a-zа-яё]?$/;
const WORK = /^OW-\d{3,}$/;

function matches(value, pattern) {
  return typeof value === 'string' && value.match(pattern)?.[0] === value;
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function validateGroup(group, seen, report) {
  if (group === null || typeof group !== 'object' || Array.isArray(group)) {
    report('live group must be an object');
    return false;
  }
  let valid = true;
  const fail = (text) => { valid = false; report(text); };
  for (const key of Object.keys(group)) {
    if (!['steps', 'threshold', 'work'].includes(key)) fail(`unknown live group key: ${key}`);
  }
  if (!Array.isArray(group.steps) || !group.steps.length) {
    fail('live group steps must be a non-empty array');
  } else {
    const local = new Set();
    for (const step of group.steps) {
      if (!matches(step, STEP)) fail('live group step must match digits with at most one lowercase letter');
      else if (local.has(step)) fail(`duplicate step ${step} in live group`);
      else if (seen.has(step)) fail(`step ${step} appears in more than one live group`);
      local.add(step);
      seen.add(step);
    }
  }
  if (group.threshold !== 'none' && !matches(group.threshold, VERSION)) {
    fail('live group threshold must be a three-integer version or none');
  }
  if (Object.hasOwn(group, 'work') && !matches(group.work, WORK)) {
    fail('live group work must match OW- followed by at least three digits');
  }
  if (group.threshold === 'none' && !Object.hasOwn(group, 'work')) {
    fail('live group with threshold none requires work');
  }
  return valid;
}

function validateHold(group, checklist, items, report) {
  const item = items.find((candidate) => candidate.id === group.work);
  if (!item) {
    report(`hold ${group.work}: item does not exist`);
    return { valid: false };
  }
  let valid = true;
  const fail = (text) => { valid = false; report(`hold ${group.work}: ${text}`); };
  const state = item.fields.find((field) => field.key === 'состояние')?.value.trim();
  if (!['open', 'blocked'].includes(state)) fail('state must be open or blocked');

  const expected = new Set(group.steps);
  let matching = 0;
  // Compare individual source lines: joining continuations would invent a hold for missing steps.
  for (const home of item.fields.filter((field) => field.key === 'дом')) {
    for (const source of home.valueLines) {
      const binding = source.value.trim().match(/^(docs\/checklists\/\S+\.md) steps (.+)$/);
      if (!binding || binding[1] !== checklist) continue;
      const steps = binding[2].split(',').map((step) => step.trim());
      const actual = new Set(steps);
      if (actual.size !== steps.length) fail(`duplicate steps in binding for ${checklist}`);
      if (actual.size !== expected.size || steps.some((step) => !expected.has(step))) {
        fail(`binding for ${checklist} has steps ${steps.join(', ')}, expected ${group.steps.join(', ')}`);
      } else if (actual.size === steps.length) matching++;
    }
  }
  if (matching !== 1) fail(`home must contain exactly one binding for ${checklist} steps ${group.steps.join(', ')}`);

  const reason = item.fields.find((field) => field.key === 'блокер')?.value.trim();
  if (group.threshold === 'none' && !reason) fail('threshold none requires a non-empty blocker');
  return { valid, reason };
}

export function checkLiveThresholds({ indexText, indexFile, version, versionFile, items }) {
  const violations = [];
  const notices = [];
  // Register continuation values can contain newlines, but diagnostics must remain one line.
  const entry = (file, line, text) => ({ file, line, text: text.replace(/[\r\n\u2028\u2029]+/g, ' ') });
  const validVersion = matches(version, VERSION);
  if (!validVersion) violations.push(entry(versionFile, 1, 'package version must be a three-integer version'));

  let active = false;
  let found = false;
  for (const [index, textLine] of indexText.split(/\r?\n/).entries()) {
    if (/^## Актуальные\s*$/.test(textLine)) {
      active = true;
      found = true;
      continue;
    }
    if (textLine.startsWith('## ')) active = false;
    if (!active || !textLine.startsWith('- [')) continue;

    const line = index + 1;
    const report = (text) => violations.push(entry(indexFile, line, text));
    const link = textLine.match(/\[[^\]]*\]\(([^)\r\n]+)\)/);
    if (!link) report('active checklist line must contain a markdown link');
    const checklist = link ? `docs/checklists/${link[1]}` : null;
    const marker = textLine.match(/ live=(\[.*\])\s*$/);
    if ((textLine.match(/ live=/g) ?? []).length !== 1 || !marker) {
      report('active checklist line must end with exactly one live= array marker');
      continue;
    }
    let groups;
    try { groups = JSON.parse(marker[1]); }
    catch {
      report('live marker contains invalid JSON');
      continue;
    }
    if (!Array.isArray(groups)) {
      report('live marker must be an array');
      continue;
    }
    const seen = new Set();
    for (const group of groups) {
      if (!validateGroup(group, seen, report) || !checklist) continue;
      const hold = Object.hasOwn(group, 'work') ? validateHold(group, checklist, items, report) : null;
      if (!validVersion) continue;
      const steps = group.steps.join(', ');
      if (group.threshold === 'none') {
        if (hold.valid) notices.push(entry(indexFile, line,
          `no threshold, held by ${group.work}: ${checklist} steps ${steps}: ${hold.reason}`));
        continue;
      }
      const compared = compareVersions(group.threshold, version);
      if (compared > 0) continue;
      if (compared === 0) {
        notices.push(entry(indexFile, line,
          `due: ${checklist} steps ${steps} wait for ${group.threshold}, the package is ${version}`));
      } else if (hold?.valid) {
        notices.push(entry(indexFile, line,
          `overdue, held by ${group.work}: ${checklist} steps ${steps} waited for ${group.threshold}`));
      } else {
        report(`overdue: ${checklist} steps ${steps} waited for ${group.threshold}, the package is ${version}`);
      }
    }
  }
  if (!found) violations.push(entry(indexFile, 1, 'checklist index is missing the ## Актуальные section'));
  return { violations, notices };
}
