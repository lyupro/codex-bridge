import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect, writeFailure } from '../../src/home/lib/write-meta.mjs';
import { makeRun, buildResult } from './test-fixtures.mjs';

test('meta.json carries the resolved worker phase for each agent', () => {
  for (const agent of ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor']) {
    const dir = makeRun({ result: buildResult([]), status: { phase: 'scope' } });
    fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ phase: 'advise', budget_minutes: 15 }));
    const { meta } = collect(dir, agent, 1);
    assert.equal(meta.phase, 'advise');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).phase, 'advise');
  }
});

test('phase is retained before a worker order exists and absent facts stay null for old runs', () => {
  const beforeWorker = makeRun({ status: { phase: 'default' } });
  assert.equal(collect(beforeWorker, 'codex-build', 1).meta.phase, 'default');
  assert.equal(collect(makeRun(), 'codex-build', 1).meta.phase, null);
});

test('runner failures retain the selected phase, including before the worker order exists', () => {
  const dir = makeRun({ status: { phase: 'scope' } });
  assert.equal(writeFailure(dir, 'codex-build', 'fixture failure').meta.phase, 'scope');
  fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ phase: 'advise' }));
  assert.equal(writeFailure(dir, 'codex-build', 'fixture failure').meta.phase, 'advise');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).phase, 'advise');
  assert.equal(writeFailure(makeRun(), 'codex-build', 'legacy failure').meta.phase, null);
});
