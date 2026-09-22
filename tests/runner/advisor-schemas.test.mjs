/** Guards the advisor answer schemas handed to Codex as --output-schema (Plan_59 D3-D5, D10). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { advisorSchema, PHASE_SCHEMAS, SCHEMAS, schemaFor } from '../../src/home/lib/runner/schemas.mjs';
import { validAdvice, validScope } from '../meta/advisor-fixtures.mjs';

const sample = (phase) => (phase === 'advise' ? validAdvice() : validScope());

// Plan_59 requires an independent test validator rather than accepting our own schema by inspection.
function validates(schema, value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type !== type) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (type === 'string') {
    const length = [...value].length;
    return !(schema.minLength !== undefined && length < schema.minLength) &&
      !(schema.maxLength !== undefined && length > schema.maxLength) &&
      (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
  }
  if (type === 'array') {
    return !(schema.minItems !== undefined && value.length < schema.minItems) &&
      !(schema.maxItems !== undefined && value.length > schema.maxItems) &&
      value.every((item) => validates(schema.items, item));
  }
  if (type === 'object') {
    return schema.required.every((key) => Object.hasOwn(value, key)) &&
      Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties, key)
        ? validates(schema.properties[key], item) : schema.additionalProperties !== false);
  }
  return true;
}
function* requiredPaths(schema, value, prefix = []) {
  if (schema.type === 'object') {
    for (const key of schema.required) yield [...prefix, key];
    for (const [key, child] of Object.entries(schema.properties)) yield* requiredPaths(child, value[key], [...prefix, key]);
  } else if (schema.type === 'array') {
    for (const [index, item] of value.entries()) yield* requiredPaths(schema.items, item, [...prefix, index]);
  }
}

test('advisor schemas are selected by phase while execution schemas retain their static map', () => {
  assert.deepEqual(Object.keys(SCHEMAS), ['codex-scout', 'codex-build', 'codex-review']);
  for (const phase of ['scope', 'advise']) {
    assert.equal(advisorSchema(phase), PHASE_SCHEMAS.advisor[phase]);
    assert.equal(schemaFor('codex-advisor', phase), advisorSchema(phase));
    assert.equal(validates(advisorSchema(phase), sample(phase)), true);
  }
  for (const phase of [undefined, '', 'other', 'toString', '__proto__']) assert.throws(() => advisorSchema(phase), RangeError);
  for (const [agent, schema] of Object.entries(SCHEMAS)) assert.equal(schemaFor(agent, 'default'), schema);
});

test('every schema object has all properties required, disallows extras and has no defaults', () => {
  function inspect(schema) {
    assert.equal(Object.hasOwn(schema, 'default'), false);
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(inspect);
    } else if (schema.type === 'array') inspect(schema.items);
  }
  inspect(advisorSchema('scope'));
  inspect(advisorSchema('advise'));
});

for (const phase of ['scope', 'advise']) {
  const schema = advisorSchema(phase);
  for (const keys of requiredPaths(schema, sample(phase))) {
    test(`${phase} schema rejects removal of required ${keys.join('.')}`, () => {
      const value = sample(phase);
      assert.equal(validates(schema, value), true);
      const parent = keys.slice(0, -1).reduce((object, key) => object[key], value);
      delete parent[keys.at(-1)];
      assert.equal(validates(schema, value), false);
    });
  }
}

for (const [name, change] of [
  ['short why', (r) => { r.why = ['one', 'two']; }],
  ['long why', (r) => { r.why = Array(6).fill('reason'); }],
  ['empty rejected', (r) => { r.rejected = []; }],
  ['short counterargument', (r) => { r.strongest_counterargument = 'x'.repeat(79); }],
  ['short pre-mortem scenario', (r) => { r.pre_mortem[0].scenario = 'x'.repeat(29); }],
  ['old falsifier', (r) => { r.falsifier = 'The obsolete free-form falsifier.'; }],
  ...[1, 4].map((count) => [`pre-mortem count ${count}`, (r) => { r.pre_mortem = Array(count).fill(r.pre_mortem[0]); }]),
  ['short early-check target', (r) => { r.pre_mortem[0].early_check.target = 'xx'; }],
  ['invalid early-check kind', (r) => { r.pre_mortem[0].early_check.kind = 'guess'; }],
  ['invalid assumption rating', (r) => { r.assumptions[0].rating = 'LIKELY'; }],
  ['old string assumption', (r) => { r.assumptions[0] = 'A claim without a rating.'; }],
  ['non-string unlisted option', (r) => { r.unlisted_option = null; }],
  ['invalid risk outcome', (r) => { r.risk_outcomes[0].outcome = 'pending'; }],
  ['non-string open question', (r) => { r.open_questions[0] = 1; }],
  ...['assumptions', 'risk_outcomes', 'pre_mortem'].map((field) => [`${field} extra`, (r) => { r[field][0].extra = true; }]),
  ['early-check extra', (r) => { r.pre_mortem[0].early_check.extra = true; }],
  ['invalid confidence', (r) => { r.confidence = 'certain'; }],
  ['empty checks', (r) => { r.independent_checks = []; }],
  ['long recommendation', (r) => { r.recommendation.text = 'x'.repeat(301); }],
  ...['\n', '\r', '\u2028', '\u2029'].flatMap((newline) => [
    ['multiline recommendation', (r) => { r.recommendation.text = `First${newline}Second`; }],
    ['trailing line terminator', (r) => { r.recommendation.text = `First${newline}`; }],
  ]),
  ['wrong type', (r) => { r.assumptions = 'none'; }],
  ['wrong array item type', (r) => { r.why[0] = 1; }],
  ['null object', (r) => { r.recommendation = null; }],
  ['top-level extra', (r) => { r.extra = true; }],
  ['recommendation extra', (r) => { r.recommendation.extra = true; }],
  ['rejected extra', (r) => { r.rejected[0].extra = true; }],
  ['check extra', (r) => { r.independent_checks[0].extra = true; }],
]) {
  test(`advise schema rejects ${name}`, () => {
    const value = validAdvice();
    assert.equal(validates(advisorSchema('advise'), value), true);
    change(value);
    assert.equal(validates(advisorSchema('advise'), value), false);
  });
}

test('schema length boundaries, all confidence values and scope types are enforced', () => {
  const value = validAdvice();
  value.recommendation.text = 'x'.repeat(300);
  value.strongest_counterargument = 'x'.repeat(80);
  value.pre_mortem[0].scenario = 'x'.repeat(30);
  value.pre_mortem[0].early_check.target = 'xxx';
  value.pre_mortem.push({ scenario: 'x'.repeat(30), early_check: { kind: 'command', target: 'npm test' } });
  value.why = Array(5).fill('reason');
  for (const confidence of ['high', 'medium', 'low']) {
    value.confidence = confidence;
    assert.equal(validates(advisorSchema('advise'), value), true);
  }
  value.assumptions = []; value.risk_outcomes = []; value.open_questions = [];
  assert.equal(validates(advisorSchema('advise'), value), true);
  const scope = { result: validScope() };
  scope.result.predicted_risks.push(...['r8', 'r9'].map((id) => ({ id, risk: 'Another risk.' })));
  assert.equal(validates(advisorSchema('scope'), scope.result), true);
  for (const patch of [{ sufficient: 'true' }, { missing_paths: [1] }, { taken_on_trust: [] },
    ...[2, 6].map((count) => ({ predicted_risks: Array(count).fill({ id: 'r1', risk: 'Risk' }) })),
    ...['r0', 'r10', 'R1', 'r1x'].map((id) => ({ predicted_risks: [{ id, risk: 'Risk' }, ...validScope().predicted_risks.slice(1)] })),
    { predicted_risks: validScope().predicted_risks.map((risk) => ({ ...risk, extra: true })) },
  ]) {
    assert.equal(validates(advisorSchema('scope'), validScope()), true);
    assert.equal(validates(advisorSchema('scope'), { ...validScope(), ...patch }), false);
  }
});
