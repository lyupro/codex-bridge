/** Guards the reply guard's responsibility split. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HOOKS = path.join(ROOT, 'src', 'home', 'hooks');

// The Plan_46 invariant scans every hook for unsafe runner-file instructions. Keeping both
// extracted responsibilities here ensures that moving text cannot silently escape that guard.
test('reply parsing and verdict text remain focused hook modules', async () => {
  for (const name of ['reply-parser.mjs', 'reply-verdicts.mjs']) {
    const source = await fs.readFile(path.join(HOOKS, name), 'utf8');
    const header = source.match(/^\/\*\* ([^\n]+) \*\//)?.[1];
    assert.ok(header, `${name} needs a one-sentence JSDoc header`);
    assert.doesNotMatch(header, /\band\b/i, `${name} must state one responsibility`);
    assert.match(header, /\.$/);
  }
});

// The 2026-08-16 refusal incident requires host refusal to stay ahead of reply parsing and the
// first disk-backed check. Blank separators keep those decision blocks visibly distinct.
test('host refusal, reply parsing, and disk checks keep their decision order', async () => {
  const source = await fs.readFile(path.join(HOOKS, 'reply-guard.mjs'), 'utf8');
  const refusal = source.indexOf('const hostRefusal = recognizeHostRefusal(reply);');
  const parsing = source.indexOf('const { runDirs, claimed } = parseReply(reply);');
  const disk = source.indexOf('if (runDir && !fs.existsSync(runDir))');

  assert.ok(refusal !== -1 && refusal < parsing);
  assert.ok(parsing < disk);
  assert.match(source, /blockForm\(missingHostOrderIdReason\);\r?\n}\r?\n\r?\n\/\*\*/);
  assert.match(source, /pass\(\);\r?\n};\r?\n\r?\nconst \{ runDirs, claimed \}/);
});
