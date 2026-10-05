/** Plan_63 D9: every registry label must reach an observable header consumer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ORDER_AGENTS, orderLabelsFor, orderFromHeader } from '../src/home/lib/order-schema.mjs';
import { parseTaskHeader } from '../src/home/lib/task-header.mjs';
import { orderOptions } from '../src/home/lib/runner/order-options.mjs';

function headerFor(agent, extra = [], omit = null) {
  const required = orderLabelsFor(agent).filter(({ required, label }) => required && label !== omit);
  return [...required, ...extra].map(({ label, example }) => `${label}: ${example}`).join('\n')
    + '\n\n# Task\nExercise the header consumer.\n';
}

const cwd = path.resolve('header-consumption-baseline');

for (const agent of ORDER_AGENTS) {
  for (const entry of orderLabelsFor(agent)) {
    test(`${agent} consumes header label "${entry.label}"`, () => {
      const baseline = parseTaskHeader(headerFor(agent, [], entry.label));
      const parsed = parseTaskHeader(headerFor(agent, [entry], entry.label));
      assert.deepEqual(baseline.problems, []);
      assert.deepEqual(parsed.problems, []);
      const without = orderFromHeader(agent, baseline);
      const withLabel = orderFromHeader(agent, parsed);
      assert.deepEqual(withLabel.problems, []);
      const before = orderOptions(agent, without.order, { cwd });
      const after = orderOptions(agent, withLabel.order, { cwd });
      assert.deepEqual(after.problems, []);

      if (entry.label === 'continue' || entry.label === 'retry') {
        // Grants authorize a pass through parsed.grant, rather than becoming ordinary options (D9).
        const [run, reason] = entry.example.split(' \u2014 ');
        assert.ok(run && reason, 'a grant example must name a run and its reason');
        assert.equal(baseline.grant, null);
        assert.deepEqual(parsed.grant, { kind: entry.label, run, reason });
        assert.equal(withLabel.order.has(entry.label), false);
        assert.deepEqual(after.options, before.options);
      } else {
        assert.equal(without.order.has(entry.label), false);
        assert.equal(withLabel.order.get(entry.label), entry.example);
        // Iterate the registry, not a hand-maintained consumer list: a future ignored label must fail.
        assert.notDeepEqual(after.options, before.options, `${entry.label}: has no runner option consumer`);
      }
    });
  }

  const accepted = new Set(orderLabelsFor(agent).map(({ label }) => label));
  const foreign = new Map(ORDER_AGENTS.flatMap((other) => orderLabelsFor(other))
    .filter(({ label }) => !accepted.has(label)).map((entry) => [entry.label, entry]));
  for (const entry of foreign.values()) {
    test(`${agent} refuses another agent's header label "${entry.label}"`, () => {
      const parsed = parseTaskHeader(headerFor(agent, [entry]));
      assert.deepEqual(parsed.problems, []);
      const { order, problems } = orderFromHeader(agent, parsed);
      assert.equal(order.has(entry.label), false);
      assert.equal(problems.length, 1);
      assert.equal(problems[0].reason, `label "${entry.label}" is not accepted by ${agent}`);
      assert.equal(problems[0].line, `${entry.label}: ${entry.example}`);
    });
  }
}
