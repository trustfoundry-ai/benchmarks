import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  defineBenchmarkAdapter,
  defineProviderAdapter,
  defineScorerAdapter
} from '../src/core/contracts/index.mjs';
import { assertValidSummary } from '../src/core/artifacts.mjs';

test('defineProviderAdapter accepts valid adapters', () => {
  const adapter = defineProviderAdapter({
    id: 'test-provider',
    version: 'test-provider-v1'
  });
  assert.equal(adapter.id, 'test-provider');
  assert.equal(adapter.version, 'test-provider-v1');
});

test('defineProviderAdapter throws when id is missing', () => {
  assert.throws(
    () => defineProviderAdapter({ version: 'v1' }),
    /missing required key 'id'/
  );
});

test('defineProviderAdapter throws when version is missing', () => {
  assert.throws(
    () => defineProviderAdapter({ id: 'x' }),
    /missing required key 'version'/
  );
});

test('defineProviderAdapter throws on non-object input', () => {
  assert.throws(() => defineProviderAdapter(null), /must be an object/);
  assert.throws(() => defineProviderAdapter('nope'), /must be an object/);
});

test('defineBenchmarkAdapter validates required keys', () => {
  const adapter = defineBenchmarkAdapter({ id: 'b', version: 'b-v1' });
  assert.equal(adapter.id, 'b');
  assert.throws(
    () => defineBenchmarkAdapter({ version: 'v1' }),
    /Benchmark adapter is missing required key 'id'/
  );
});

test('defineScorerAdapter validates required keys', () => {
  const adapter = defineScorerAdapter({ id: 's', version: 's-v1' });
  assert.equal(adapter.id, 's');
  assert.throws(
    () => defineScorerAdapter({ id: 's' }),
    /Scorer adapter is missing required key 'version'/
  );
});

const CANONICAL_SUMMARY = {
  overall: { hit_at: { 'hit@1': 0.9 }, mrr: 0.9, n: 10 },
  headline: {
    metric: 'hit@1',
    macro: 0.9,
    pooled: 0.9,
    per_category: {},
    ci95: [0.8, 0.95],
    n_categories: 1,
    n_rows: 10
  }
};

// assertValidSummary is synchronous -- it throws immediately rather than
// returning a rejected promise, so violations are asserted with
// `assert.throws`, not `assert.rejects`.
test('a summary without a headline block is rejected', () => {
  assert.throws(
    () => assertValidSummary({ overall: { hit_at: { 'hit@1': 1 }, mrr: 1, n: 1 } }),
    /headline/
  );
});

test('a canonical summary is accepted', () => {
  assertValidSummary(CANONICAL_SUMMARY);
});

test('a headline whose metric does not match ^hit@\\d+$ is rejected', () => {
  assert.throws(
    () =>
      assertValidSummary({
        ...CANONICAL_SUMMARY,
        headline: { ...CANONICAL_SUMMARY.headline, metric: 'macro_hit_at_1' }
      }),
    /headline\.metric/
  );
});

// Binds the hand-written validator to the declarative schema block in
// artifact-schemas.json: without this test, the two can drift the same way
// the bare `{"type": "object"}` and two suites' summary vocabularies did.
test('assertValidSummary enforces exactly the required keys declared in artifact-schemas.json', async () => {
  const schemas = JSON.parse(
    await readFile(
      path.join(process.cwd(), 'src/core/contracts/artifact-schemas.json'),
      'utf8'
    )
  );
  const summarySchema = schemas.$defs['result.v1'].properties.summary;
  assert.deepEqual([...summarySchema.required].sort(), ['headline', 'overall']);

  const overallRequired = summarySchema.properties.overall.required;
  const headlineRequired = summarySchema.properties.headline.required;
  assert.ok(overallRequired.length > 0, 'summary.overall declares no required keys to bind against');
  assert.ok(headlineRequired.length > 0, 'summary.headline declares no required keys to bind against');

  assertValidSummary(structuredClone(CANONICAL_SUMMARY));

  for (const key of overallRequired) {
    const missing = structuredClone(CANONICAL_SUMMARY);
    delete missing.overall[key];
    assert.throws(
      () => assertValidSummary(missing),
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `summary.overall.${key} should be enforced as required`
    );
  }
  for (const key of headlineRequired) {
    const missing = structuredClone(CANONICAL_SUMMARY);
    delete missing.headline[key];
    assert.throws(
      () => assertValidSummary(missing),
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `summary.headline.${key} should be enforced as required`
    );
  }
});
