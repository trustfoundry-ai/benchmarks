import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRegistry,
  createTestRegistry,
  defaultRegistry,
  makeFixtureAdapter,
  makeFixtureCase
} from '../src/testing/index.mjs';

test('createTestRegistry returns a fresh empty registry with a register method', () => {
  const registry = createTestRegistry();
  assert.equal(registry.benchmarks.size, 0);
  assert.equal(registry.providers.size, 0);
  assert.equal(registry.scorers.size, 0);
  registry.register('providers', { id: 'test-prov', version: 'v1' });
  assert.equal(registry.providers.size, 1);
  // separate registry stays empty
  assert.equal(createTestRegistry().providers.size, 0);
});

test('createRegistry is available for consumers that want the runtime factory', () => {
  const registry = createRegistry();
  assert.equal(registry.benchmarks.size, 0);
});

test('defaultRegistry is populated with the shipped adapters', () => {
  assert.ok(defaultRegistry.benchmarks.size > 0);
  assert.ok(defaultRegistry.providers.size > 0);
  assert.ok(defaultRegistry.scorers.size > 0);
});

test('makeFixtureCase produces a normalized benchmark case', () => {
  const fixture = makeFixtureCase({ caseId: 'x', query: 'hello' });
  assert.equal(fixture.caseId, 'x');
  assert.equal(fixture.benchmarkId, 'fixture');
  assert.equal(fixture.query, 'hello');
  assert.deepEqual(fixture.metadata, {});
});

test('makeFixtureAdapter returns a completed provider result', async () => {
  const adapter = makeFixtureAdapter({ response: { finalOutputText: 'yep' } });
  assert.equal(adapter.id, 'fixture-provider');
  const description = await adapter.describe();
  assert.equal(description.id, 'fixture-provider');
  const result = await adapter.executeCase({ benchmarkCase: { caseId: 'y' } });
  assert.equal(result.caseId, 'y');
  assert.equal(result.status, 'completed');
  assert.equal(result.finalOutputText, 'yep');
});
