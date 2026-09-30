/**
 * Plan_73: scope preflight on file names git would quote (Cyrillic — the 2026-09-30 vault refusal) and on
 * patterns a line-per-pattern scope list cannot store (D7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { validateScope } from '../../src/home/lib/runner/scope-check.mjs';

function repository(t, suffix) {
  const root = makeTempTree(`scope-names-${suffix}-`);
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  return repo;
}

test('an existing Cyrillic file matches by literal path, ASCII glob and any case', (t) => {
  const repo = repository(t, 'cyrillic');
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  fs.mkdirSync(path.join(repo, 'areas'));
  fs.writeFileSync(path.join(repo, 'areas', 'tickets-и-notifier.md'), 'Ticket.\n');
  for (const pattern of ['areas/tickets-и-notifier.md', 'areas/tickets-*-notifier.md', 'AREAS/TICKETS-И-NOTIFIER.MD']) {
    assert.equal(validateScope(repo, [pattern]), null, pattern);
  }
  assert.match(validateScope(repo, ['areas/tickets-я-notifier.md']).reason, /does not match any existing path/i);
});

test('line breaks in either scope list are refused before any git call', (t) => {
  const repo = repository(t, 'line-breaks');
  const script = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
cp.spawnSync = () => { throw new Error('git must not be called'); }; syncBuiltinESMExports();
const { validateScope } = await import(${JSON.stringify(new URL('../../src/home/lib/runner/scope-check.mjs', import.meta.url).href)});
for (const pattern of ['src/a\\nb.mjs', 'src/a\\rb.mjs', 'src/existing.mjs\\n', '\\rsrc/existing.mjs']) {
  for (const scopeNew of [false, true]) {
    const refusal = validateScope(${JSON.stringify(repo)}, scopeNew ? ['missing.mjs'] : [pattern], scopeNew ? [pattern] : []);
    if (refusal.pattern !== pattern || !/newline|carriage return/.test(refusal.reason) || !/glob/.test(refusal.action)) throw new Error(JSON.stringify(refusal));
  }
}`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).status, 0);
});
