/**
 * Plan_56 D27: knowing the run-config path and writing files belongs to one edit boundary.
 * The installer copies a seed template; it does not own the runtime config path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITER = 'src/home/lib/config-edit.mjs';

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [file] : [];
  });
}

function withoutComments(source) {
  // Preserve strings: both imported API names and literal config paths carry the invariant.
  return source.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('//') || token.startsWith('/*') ? ' ' : token);
}

function knowsConfigPath(source) {
  return /\b(?:BRAND_CONFIG_PATH|CONFIG_PATH|brandConfigPath)\b|\bBRAND_HOME\s*\.\s*configPath\b/.test(source)
    || /["'`][^"'`]*\.codex-bridge[/\\]+config\.json["'`]/.test(source)
    || /\b(?:join|resolve)\s*\([^;]*?["']config\.json["']\s*\)/.test(source)
    || /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|open(?:Sync)?)\s*\(\s*["']config\.json["']/.test(source);
}

function callsFileWriter(source) {
  const apis = '(?:writeFile|appendFile|writev?|truncate|ftruncate|rename)(?:Sync)?|createWriteStream';
  if (new RegExp(`\\b(?:${apis})\\s*\\(`).test(source)) return true;
  // Imports can rename a writer; a local alias must not make the guard blind.
  for (const match of source.matchAll(new RegExp(`\\b(${apis})\\s+as\\s+(\\w+)`, 'g'))) {
    if (new RegExp(`\\b${match[2]}\\s*\\(`).test(source)) return true;
  }
  // D27 leaves template copying alone; copying explicitly onto the runtime path is still a write.
  if ([...source.matchAll(/\b(?:copyFile|cp)(?:Sync)?\s*\([^,]+,\s*([^;\n]+)/g)]
    .some(([, target]) => knowsConfigPath(target))) return true;
  return /\bopen(?:Sync)?\s*\([^,]+,\s*["'][wa][^"']*["']/.test(source)
    || /\bopen(?:Sync)?\s*\([^,]+,\s*["']r\+[^"']*["']/.test(source);
}

function offenders(files) {
  return files.filter(({ file, source }) => {
    const code = withoutComments(source);
    // D40: a prepared value can overwrite edits made during the caller's catalogue wait.
    const staleEdit = /\beditRunConfig\s*\(\s*\{[^}]*\b(?:key|value)\s*[:,}]/.test(code);
    return staleEdit || (file !== WRITER && knowsConfigPath(code) && callsFileWriter(code));
  }).map(({ file }) => file).sort();
}

function assertOneWriter(files) {
  const found = offenders(files);
  assert.deepEqual(found, [], `Run-config writes must use ${WRITER}. Offenders: ${found.join(', ')}`);
}

const sources = ['src', 'cli'].flatMap((directory) => sourceFiles(path.join(root, directory)))
  .map((file) => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    source: fs.readFileSync(file, 'utf8'),
  }));

test('only config-edit owns the runtime config path and a file-writing API', () => {
  assert.ok(sources.some(({ file }) => file === WRITER), 'The single writer must exist');
  assertOneWriter(sources);
});

test('the guard fails on planted config writers in either scanned directory', () => {
  // Plant in the scan input, not the live worktree: reverse checks must not race other guards.
  const violations = [
    "import { CONFIG_PATH } from './run-config.mjs'; fs.writeFileSync(CONFIG_PATH, '{}');",
    "import { BRAND_CONFIG_PATH as target } from './brand-home.mjs'; await fs.writeFile(target, '{}');",
    "import { writeFile as persist } from 'node:fs/promises'; persist(CONFIG_PATH, '{}');",
    "const target = path.join(root, 'config.json'); fs.renameSync(temporary, target);",
    "const target = '/home/operator/.codex-bridge/config.json'; fs.appendFileSync(target, '{}');",
    "const target = path.resolve(root, 'config.json'); createWriteStream(target);",
    "await fs.open(BRAND_HOME.configPath, 'w');",
    "fs.openSync(CONFIG_PATH, 'r+');",
    "fs.copyFileSync(seed, CONFIG_PATH);",
    "fs.writeFileSync('config.json', '{}');",
    "editRunConfig({ key: 'models', value: profiles });",
    "await editRunConfig({ key, value: profiles }, configPath);",
    "editRunConfig({ value: profiles, key: 'models' });",
  ];
  for (const directory of ['src/home/lib', 'cli']) {
    for (const source of violations) {
      const file = `${directory}/planted-writer.mjs`;
      const planted = [...sources, { file, source }];
      assert.ok(offenders(planted).includes(file), source);
      assert.throws(() => assertOneWriter(planted), { code: 'ERR_ASSERTION' }, source);
    }
  }
});

test('the guard permits readers, generic writers, and the designated editor', () => {
  for (const source of [
    "import { CONFIG_PATH } from './run-config.mjs'; fs.readFileSync(CONFIG_PATH);",
    "export function save(file, value) { fs.writeFileSync(file, value); }",
    "// fs.writeFileSync(CONFIG_PATH, '{}');\nexport const value = 1;",
    "/* CONFIG_PATH */ fs.writeFileSync(output, '{}');",
    "const seed = 'src/home/config.json'; fs.copyFileSync(seed, target);",
    "const legacy = path.join(agentsDir, 'run-config.json'); fs.copyFileSync(legacy, seed.target);",
    "readRunConfig(host.brandConfigPath); fs.copyFile(legacy, seed.target);",
    "await editRunConfig('models', (profiles) => ({ ...profiles, build: {} }), configPath);",
    "await editRunConfig('models', transform, configPath);",
    "await editRunConfig({ reset: true }, undefined, configPath);",
  ]) {
    assert.deepEqual(offenders([{ file: 'cli/example.mjs', source }]), [], source);
  }
  assert.deepEqual(offenders([{ file: WRITER, source: "fs.writeFileSync(CONFIG_PATH, '{}');" }]), []);
});
