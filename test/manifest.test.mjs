import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertCompatibleManifest,
  buildManifest,
  computeFingerprints
} from '../src/core/manifest.mjs';

function baseManifest() {
  return {
    benchmark: { id: 'b1', version: 'v1', configSha256: 'aaa' },
    provider: { id: 'p1', version: 'v1', configSha256: 'bbb' },
    scorer: { id: 's1', configSha256: 'ccc' }
  };
}

test('computeFingerprints is deterministic for the same identity fields', () => {
  const a = computeFingerprints(baseManifest());
  const b = computeFingerprints(baseManifest());
  assert.equal(a.compatibility, b.compatibility);
});

test('computeFingerprints changes when benchmark config sha256 changes', () => {
  const original = computeFingerprints(baseManifest());
  const mutated = { ...baseManifest(), benchmark: { ...baseManifest().benchmark, configSha256: 'ZZZ' } };
  const after = computeFingerprints(mutated);
  assert.notEqual(original.compatibility, after.compatibility);
});

test('computeFingerprints ignores non-identity fields like runId', () => {
  const a = computeFingerprints({ ...baseManifest(), runId: 'r-1' });
  const b = computeFingerprints({ ...baseManifest(), runId: 'r-2' });
  assert.equal(a.compatibility, b.compatibility);
});

test('assertCompatibleManifest passes when compatibility fingerprints match', () => {
  const left = { fingerprints: computeFingerprints(baseManifest()) };
  const right = { fingerprints: computeFingerprints(baseManifest()) };
  assert.doesNotThrow(() => assertCompatibleManifest(left, right));
});

test('assertCompatibleManifest throws when fingerprints disagree', () => {
  const left = { fingerprints: computeFingerprints(baseManifest()) };
  const mutated = { ...baseManifest(), provider: { ...baseManifest().provider, configSha256: 'XXX' } };
  const right = { fingerprints: computeFingerprints(mutated) };
  assert.throws(() => assertCompatibleManifest(left, right), /compatibility fingerprints do not match/);
});

test('assertCompatibleManifest computes fingerprints on the fly for legacy manifests', () => {
  const legacy = baseManifest(); // no fingerprints block
  const current = { fingerprints: computeFingerprints(baseManifest()) };
  assert.doesNotThrow(() => assertCompatibleManifest(legacy, current));
});

test('buildManifest records harness.dirty', async () => {
  const manifest = await buildManifest({
    repoRoot: process.cwd(),
    runId: 'test-run',
    benchmark: { id: 'b1', version: 'v1' },
    provider: { id: 'p1', version: 'v1' },
    scorerId: 's1',
    paths: {},
    sourceFiles: [],
    scheduler: { caseCount: 0, parallel: 1, retries: 0, shardCount: 1, shardIndex: 0 }
  });
  assert.ok('dirty' in manifest.harness, 'harness.dirty must be present');
  assert.ok(
    typeof manifest.harness.dirty === 'boolean' || manifest.harness.dirty === null,
    'harness.dirty must be boolean or null'
  );
});
