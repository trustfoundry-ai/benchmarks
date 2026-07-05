import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defineBenchmarkAdapter,
  defineProviderAdapter,
  defineScorerAdapter
} from '../src/core/contracts/index.mjs';

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
