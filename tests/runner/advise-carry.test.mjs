/** Guards the shared scope snapshot required after run 2026-09-23_141341_plan59-a1-stdin-hang. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { validScope } from '../meta/advisor-fixtures.mjs';
import { adviseSection, advisorTaskArtifact } from '../../src/home/lib/runner/advise-carry.mjs';

const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- src/entry.mjs\n';

function scopeFixture() {
  return {
    ...validScope(),
    predicted_risks: [
      { id: 'r1', risk: 'Concurrent callers may share mutable state.' },
      { id: 'r2', risk: 'A retry may reuse stale results.' },
      { id: 'r3', risk: 'An absent caller contract may hide a migration.' },
    ],
    missing_paths: ['src/caller.mjs', 'docs/contract.md'],
  };
}

function writeScopeResult(runsRoot, run, result) {
  const runDir = path.join(runsRoot, run);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result));
}

test('advise artifact and prompt section carry every predicted risk and missing path', () => {
  const root = makeTempTree('advise-carry-');
  const runsRoot = path.join(root, 'runs');
  const scope = scopeFixture();
  writeScopeResult(runsRoot, 'scope-run', scope);
  const artifact = advisorTaskArtifact({ taskText: TASK, phase: 'advise', runsRoot, grantRun: 'scope-run' });
  const section = adviseSection(artifact);
  assert.deepEqual(artifact.scope, { run: 'scope-run', predicted_risks: scope.predicted_risks, missing_paths: scope.missing_paths });
  for (const { id, risk } of scope.predicted_risks) {
    assert.ok(artifact.scope.predicted_risks.some((entry) => entry.id === id));
    assert.ok(section.includes(`- ${id}: ${risk}`));
  }
  for (const entry of scope.missing_paths) assert.ok(section.includes(`- ${entry}`));
  assert.ok(section.includes('Paths you may additionally read and cite:'));
});

test('scope phase artifact has no scope snapshot', () => {
  const artifact = advisorTaskArtifact({ taskText: TASK, phase: 'scope', runsRoot: 'unused', grantRun: undefined });
  assert.equal(Object.hasOwn(artifact, 'scope'), false);
  assert.equal(adviseSection(artifact), '');
});

test('missing scope result throws a clear error', () => {
  const root = makeTempTree('advise-carry-missing-');
  assert.throws(
    () => advisorTaskArtifact({ taskText: TASK, phase: 'advise', runsRoot: path.join(root, 'runs'), grantRun: 'missing-run' }),
    /Cannot read advise scope result.*result\.json/,
  );
});
