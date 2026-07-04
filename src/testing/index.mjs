/**
 * Test helpers for downstream harness consumers.
 *
 * Reference implementations of fixtures and a fresh registry factory
 * so consumer tests can exercise the runner + scorer machinery without
 * reaching into internal `src/core/*` modules.
 *
 *   import { makeFixtureCase, makeFixtureAdapter, createTestRegistry }
 *     from '@trustfoundry-ai/benchmarks-harness/testing';
 */

import { createRegistry } from '../core/registry.mjs';

export { createRegistry, defaultRegistry } from '../core/registry.mjs';

// Alias kept as a separate export so consumers can pin against a
// testing surface that may diverge from the runtime factory later.
export function createTestRegistry() {
  return createRegistry();
}

export function makeFixtureCase({
  caseId,
  benchmarkId = 'fixture',
  query = 'test query',
  metadata = {},
  expected = {},
  scoringHints = {}
} = {}) {
  return {
    caseId: caseId ?? `fixture-${Math.random().toString(36).slice(2, 8)}`,
    benchmarkId,
    query,
    metadata,
    scoringHints,
    expected
  };
}

export function makeFixtureAdapter({
  id = 'fixture-provider',
  version = 'fixture-provider-v1',
  response = { finalOutputText: 'ok' }
} = {}) {
  return {
    id,
    version,
    async describe() {
      return { id, version };
    },
    async executeCase({ benchmarkCase }) {
      return {
        caseId: benchmarkCase.caseId,
        status: 'completed',
        ...response
      };
    }
  };
}
