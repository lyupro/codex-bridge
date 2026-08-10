/** Defines the package install mappings and renders files before they are copied. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS } from '../src/hook-definitions.mjs';
import {
  renderRequiredInputSummary,
  renderRequiredInputs,
} from '../src/required-inputs.mjs';
import { renderNoSelfExecution } from '../src/no-self-execution.mjs';
import { renderStopSummary } from '../src/stop-contract.mjs';
import { readJsonFile } from '../src/json-file.mjs';
import {
  INSTALL_RECORD_NAME,
  RULES_NAME,
  definitionForRecordedHook,
  fileEntry,
  installRecordPath,
  legacyInstallRecordPath,
  normalizeInstallRecord,
  readInstallRecord,
  recordFileKey,
  recordMatchesPackage,
  recordTarget,
  validateInstallRecord,
  writeInstallRecord,
} from './install-record.mjs';

export {
  HOOK_DEFINITIONS,
  INSTALL_RECORD_NAME,
  RULES_NAME,
  definitionForRecordedHook,
  installRecordPath,
  legacyInstallRecordPath,
  normalizeInstallRecord,
  readInstallRecord,
  recordFileKey,
  recordMatchesPackage,
  recordTarget,
  validateInstallRecord,
  writeInstallRecord,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
const RULES_SOURCE = `src/rules/${RULES_NAME}`;

/**
 * Files the operator owns once they exist. Seeded on first install so the defaults are
 * visible and editable, then never written, never compared, never removed: run-config.json
 * is where a host states which model each mode runs on, conventions.md is the rule set it hands
 * every run, and an installer that overwrites either would erase host decisions on the next
 * update — the same way overwriting a .env would.
 */
export const SEEDED_SOURCES = Object.freeze(['src/run-config.json', 'src/conventions.md']);

export const INSTALL_TABLE = Object.freeze([
  { source: 'src/agents/*.md', root: 'claude', target: 'agentsDir', processing: 'placeholders' },
  { source: 'src/commands/*.md', root: 'claude', target: 'commandsDir', processing: 'placeholders' },
  { source: 'src/hooks/**', root: 'brand', target: 'brandHooksDir', processing: 'copy' },
  { source: 'src/**', root: 'brand', target: 'brandRunnerDir', processing: 'copy' },
]);

const posix = (value) => value.split(path.sep).join('/');

export function replacePlaceholders(content, installationRoot) {
  const agentType = content.match(/^name:\s*([^\r\n]+)$/m)?.[1].trim();
  return content
    .replaceAll('{{CODEX_BRIDGE_DIR}}', posix(path.resolve(installationRoot)))
    .replaceAll('{{CODEX_REQUIRED_INPUTS_SUMMARY}}', renderRequiredInputSummary(agentType))
    .replaceAll('{{CODEX_REQUIRED_INPUTS}}', renderRequiredInputs(agentType))
    .replaceAll('{{CODEX_NO_SELF_EXECUTION}}', renderNoSelfExecution())
    .replaceAll('{{CODEX_STOP_SUMMARY}}', renderStopSummary());
}

export async function packageInfo(packageRoot = PACKAGE_ROOT) {
  const parsed = await readJsonFile(path.join(packageRoot, 'package.json'));
  return { name: parsed.name, version: parsed.version };
}

export function installedHookPath(host, definition) {
  return path.join(host.brandHooksDir, definition.file);
}

/** Where each seeded file comes from and where it goes; contents are copied verbatim. */
export function seedPlan(host, packageRoot = PACKAGE_ROOT) {
  return SEEDED_SOURCES.map((source) => {
    const target = source.endsWith('run-config.json')
      ? host.brandConfigPath
      : host.brandConventionsPath;
    return {
      source: path.join(packageRoot, source),
      target,
      root: 'brand',
      relativeToRoot: posix(path.relative(host.brandRoot, target)),
      processing: 'copy',
    };
  });
}

export function rulesPlan(host, packageRoot = PACKAGE_ROOT) {
  return {
    source: path.join(packageRoot, RULES_SOURCE),
    target: path.join(host.codexRulesDir, RULES_NAME),
    name: RULES_NAME,
  };
}

export async function fileFingerprint(absolutePath) {
  try {
    return createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function targetBase(host, mapping) {
  const base = host[mapping.target];
  if (!base) throw new Error(`host has no ${mapping.target} install target`);
  return base;
}

function rootFor(host, mapping) {
  return mapping.root === 'brand' ? host.brandRoot : host.root;
}

function targetRelative(packageRoot, source, mapping) {
  if (mapping.processing === 'placeholders') return path.basename(source);
  const sourceRoot = mapping.source === 'src/hooks/**'
    ? path.join(packageRoot, 'src', 'hooks')
    : path.join(packageRoot, 'src');
  return path.relative(sourceRoot, source);
}

export async function buildInstallPlan(host, packageRoot = PACKAGE_ROOT) {
  const files = [];
  const claimedSources = [];
  for (const mapping of INSTALL_TABLE) {
    for await (const relative of fs.glob(mapping.source, { cwd: packageRoot, exclude: claimedSources })) {
      if (posix(relative) === RULES_SOURCE || SEEDED_SOURCES.includes(posix(relative))) continue;
      const source = path.join(packageRoot, relative);
      if (!(await fs.stat(source)).isFile()) continue;
      const relativeToTarget = posix(targetRelative(packageRoot, source, mapping));
      const target = path.join(targetBase(host, mapping), relativeToTarget);
      const relativeToRoot = posix(path.relative(rootFor(host, mapping), target));
      files.push({
        source,
        target,
        root: mapping.root,
        relativeToRoot,
        relativeToHost: posix(path.relative(host.root, target)),
        processing: mapping.processing,
        installationRoot: mapping.processing === 'placeholders'
          ? host.brandRunnerDir
          : rootFor(host, mapping),
      });
    }
    claimedSources.push(mapping.source);
  }
  return files.sort((a, b) => recordFileKey(a).localeCompare(recordFileKey(b)));
}

export function targetForPlanItem(host, item) {
  return recordTarget(host, fileEntry({ root: item.root, path: item.relativeToRoot }));
}
