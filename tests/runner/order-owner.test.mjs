/** Plan_75 D5: one wording for an order-id collision, honest about owners recorded before hash scheme 2. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderOwnerConflictText, ownerPredatesHashScheme } from '../../src/home/lib/runner/order-owner.mjs';

for (const [scheme, expected] of [[undefined, true], [1, true], [2, false]]) {
  test(`ownerPredatesHashScheme recognizes ${scheme === undefined ? 'a missing field' : `scheme ${scheme}`}`, () => {
    const status = scheme === undefined ? {} : { task_hash_scheme: scheme };

    assert.equal(ownerPredatesHashScheme({ status }), expected);
  });
}

// Plan_75 P4a4b: wording belongs here so attach only verifies that it prints the shared text.
for (const scheme of [undefined, 1, 2]) {
  test(`order collision wording is truthful for ${scheme === undefined ? 'a missing scheme' : `scheme ${scheme}`}`, () => {
    const dir = 'C:/runs/2026-08-15_090000_plan42-run2';
    const status = {
      slug: 'plan42-run2',
      started_at: '2026-08-15T09:00:00.000Z',
      ...(scheme === undefined ? {} : { task_hash_scheme: scheme }),
    };
    const text = orderOwnerConflictText({ status }, dir, 'order-1');

    assert.ok(text.includes(dir));
    assert.match(text, /slug plan42-run2, started_at 2026-08-15T09:00:00.000Z/);
    assert.match(text, /new order id/);
    assert.match(text, /continue:\/retry: header line/);
    if (scheme === 2) {
      assert.match(text, /with a different task/);
      assert.doesNotMatch(text, /cannot be compared/);
    } else {
      assert.match(text, /recorded before the task header \(hash scheme 2\), so its task cannot be compared/);
      assert.match(text, /answer is already on disk/);
      assert.ok(text.includes(`codex-bridge read "${dir}"`));
      assert.doesNotMatch(text, /different task|ATTACH=/);
    }
  });
}
