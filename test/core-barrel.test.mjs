import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as core from '../src/core/index.mjs';

test('core barrel exposes the new Phase 2 helpers', () => {
  assert.equal(typeof core.FileBackedRateLimiter, 'function');
  assert.equal(typeof core.createProviderRateLimiter, 'function');
  assert.equal(typeof core.rateLimitedProviderResult, 'function');
  assert.equal(typeof core.retryFailed, 'function');
  assert.equal(typeof core.defaultRetryFilter, 'function');
  assert.equal(typeof core.summarizeTokenUsage, 'function');
  assert.equal(typeof core.normalizeTokenUsage, 'function');
  assert.equal(typeof core.CheckpointStore, 'function');
  assert.equal(typeof core.buildManifest, 'function');
  assert.equal(typeof core.computeFingerprints, 'function');
  assert.equal(typeof core.assertCompatibleManifest, 'function');
  assert.equal(typeof core.mergeRuns, 'function');
});

test('core barrel still exposes pre-existing runner/registry helpers', () => {
  assert.equal(typeof core.executeRun, 'function');
  assert.equal(typeof core.scoreRun, 'function');
  assert.equal(typeof core.defaultPaths, 'function');
  assert.equal(typeof core.getAdapter, 'function');
  assert.equal(typeof core.readJson, 'function');
});
