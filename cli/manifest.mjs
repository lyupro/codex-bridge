/** Defines the package install mappings and renders files before they are copied. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS } from '../src/home/lib/hook-definitions.mjs';
import {
  renderRequiredInputSummary,
  renderRequiredInputs,
} from '../src/home/lib/required-inputs.mjs';
import { renderNoSelfExecution } from '../src/home/lib/no-self-execution.mjs';
import { renderStopSummary } from '../src/home/lib/stop-contract.mjs';
import { readJsonFile } from '../src/home/lib/json-file.mjs';
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
 * visible and editable, then never written, never compared, never removed: config.json
 * is where a host states which model each mode runs on, conventions.md is the rule set it hands
 * every run, and an installer that overwrites either would erase host decisions on the next
 * update — the same way overwriting a .env would.
 */
export const SEEDED_SOURCES = Object.freeze(['src/home/config.json', 'src/home/conventions.md']);

export const INSTALL_TABLE = Object.freeze([
  { source: 'src/agents/*.md', root: 'claude', target: 'agentsDir', processing: 'placeholders' },
  { source: 'src/commands/*.md', root: 'claude', target: 'commandsDir', processing: 'placeholders' },
  // The source is the host image. Keeping one source root and one target root makes any future
  // remapping visible as a test failure instead of another clone-only import success.
  { source: 'src/home/**', root: 'brand', target: 'brandRoot', processing: 'copy' },
  // The runner reads its own version out of the package.json beside it, so meta.json can say
  // which code wrote a run (Plan_34). In the clone that file sits one level above src/; without
  // this line the installed layout has nothing one level above lib/, and every run on a real host
  // would die on import while the whole suite stayed green against the clone.
  { source: 'package.json', root: 'brand', target: 'brandRoot', processing: 'copy' },
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
    const relativeToRoot = posix(path.relative('src/home', source));
    const target = path.join(host.brandRoot, relativeToRoot);
    return {
      source: path.join(packageRoot, source),
      target,
      root: 'brand',
      relativeToRoot,
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
  if (mapping.processing === 'placeholders' || mapping.source === 'package.json') {
    return path.basename(source);
  }
  return path.relative(path.join(packageRoot, 'src', 'home'), source);
}

export async function buildInstallPlan(host, packageRoot = PACKAGE_ROOT) {
  const files = [];
  for (const mapping of INSTALL_TABLE) {
    for await (const relative of fs.glob(mapping.source, { cwd: packageRoot })) {
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
  }
  return files.sort((a, b) => recordFileKey(a).localeCompare(recordFileKey(b)));
}

export function targetForPlanItem(host, item) {
  return recordTarget(host, fileEntry({ root: item.root, path: item.relativeToRoot }));
}
