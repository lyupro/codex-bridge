/** Reports whether what this package installed into the host still matches the package. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildInstallPlan,
  contentFingerprint,
  fileFingerprint,
} from './manifest.mjs';
import { plannedContent } from './copy.mjs';
import { inspectPermissions } from './permissions.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { check } from './doctor-format.mjs';

export async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function agentsCheck(host, record) {
  if (!record) return check('agents', 'warn', 'Agent definitions were not checked; run codex-bridge install');
  const plan = await buildInstallPlan(host);
  const agents = plan.filter((item) => /[\\/]src[\\/]agents[\\/][^\\/]+\.md$/.test(item.source));
  const mismatches = [];
  const unreadable = [];
  for (const item of agents) {
    const expected = contentFingerprint(await plannedContent(item, host.brandRoot));
    if (await fileFingerprint(item.target) !== expected) mismatches.push(path.basename(item.target));
    const expectedName = path.basename(item.source, '.md');
    try {
      const frontmatter = parseFrontmatter(await fs.readFile(item.target, 'utf8'));
      if (!frontmatter) throw new Error('frontmatter is missing');
      if (frontmatter.name !== expectedName) {
        throw new Error(`name is ${JSON.stringify(frontmatter.name)}, expected ${JSON.stringify(expectedName)}`);
      }
    } catch (err) {
      unreadable.push(`${path.basename(item.target)} (${err.message})`);
    }
  }
  // The 2026-08-10 registration failure left files present but unreadable by Claude Code. Drift was
  // advisory until a 2026-08-16 checklist run planted the pre-Plan_41 invocation — a path instead of
  // the package command — in an installed definition: doctor kept exit 0 while every delegation
  // would stop on a permission prompt. A definition that is not this package's is not judged healthy.
  if (unreadable.length) {
    return check('agents', 'fail', `Installed agent definitions cannot be read: ${unreadable.join(', ')}; run codex-bridge update --force`);
  }
  return mismatches.length
    ? check('agents', 'fail', `Installed agent definitions differ from this package: ${mismatches.join(', ')}; run codex-bridge update --force`)
    : check('agents', 'ok', `${agents.length} installed agent definition(s) match this package`);
}

export async function conventionsCheck(host) {
  const file = host.brandConventionsPath;
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return check('conventions', 'ok', `${file} (not found; optional)`);
    return check('conventions', 'fail', `cannot read ${file}: ${err.message}`);
  }
  return content.trim()
    ? check('conventions', 'ok', `${file} (found)`)
    : check('conventions', 'warn', `${file} (found but empty)`);
}

export async function rulesCheck(host, record) {
  if (!record) return check('rules', 'warn', 'cannot check before installation');
  if (!record.rules) {
    return check('rules', 'warn', 'rules were not installed by this installation; install or update will add them');
  }
  let registry;
  try {
    registry = await readRulesRegistry(host);
  } catch (err) {
    // Keep every diagnostic visible: package removal on a broken registry left the host without its watchdog.
    return check('rules', 'fail', err.message);
  }
  const ownerNote = registry?.owners.length > 1 ? `; ${registry.owners.length} owners` : '';
  const fingerprint = await fileFingerprint(record.rules.path);
  if (!fingerprint) return check('rules', 'fail', `${record.rules.path}${ownerNote ? ` (${registry.owners.length} owners)` : ''}`);
  return fingerprint === record.rules.fingerprint
    ? check('rules', 'ok', `${record.rules.path} (matches record${ownerNote})`)
    : check('rules', 'warn', `${record.rules.path} (modified after installation${ownerNote})`);
}

export async function permissionsCheck(host) {
  try {
    const status = await inspectPermissions(host.settingsPath);
    // Permission rules are an optional operator action; Plan_22 keeps their absence a warning so
    // doctor does not turn a healthy installation red merely because hardening was not requested.
    // The ask count is part of the line because a full set shadowed by `ask` reads as working and
    // is not: the live run of Plan_22-1 found this line saying `installed (24/24)` over it.
    const shadow = status.askCount ? `, ${status.askCount} shadowed by ask` : '';
    return check('permissions', status.state === 'installed' ? 'ok' : 'warn',
      `${status.state} (${status.present}/${status.total} own strings in allow/deny${shadow})`);
  } catch (err) {
    return check('permissions', 'warn', `cannot inspect permission rules: ${err.message}`);
  }
}
