import assert from 'node:assert/strict';
import test from 'node:test';

import * as publicApi from '../src/index.mjs';

// The public API surface is the set of named exports on
// `@trustfoundry-ai/benchmarks-harness`. Symbols added here become
// subject to semver: additive changes only within a minor version, and
// nothing is removed or renamed except at a major bump.
//
// If this snapshot fails, either:
//   1. You intentionally added / removed a public export — update the
//      list below AND add a CHANGELOG entry so the change is announced.
//   2. You accidentally leaked an internal helper into the root barrel —
//      revert the barrel edit; import from a subpath instead.
const EXPECTED_PUBLIC_EXPORTS = [
  'FileBackedRateLimiter',
  'STRIP_SYNTHETIC_INSTRUCTION_PREFIXES',
  'acceptedCitationSet',
  'adapterInventory',
  'applyQueryTransform',
  'applyShard',
  'assertCompatibleManifest',
  'benchmarkAdapterId',
  'buildManifest',
  'buildRawRow',
  'buildRawRows',
  'buildReport',
  'canonicalStringify',
  'casesForRetrySelection',
  'clearCheckpoints',
  'computeFingerprints',
  'createJsonlWriter',
  'createProviderRateLimiter',
  'createRegistry',
  'defaultRegistry',
  'defaultRetryFilter',
  'defineBenchmarkAdapter',
  'defineProviderAdapter',
  'defineScorerAdapter',
  'executeProviderCaseWithRetry',
  'executeRun',
  'exists',
  'getAdapter',
  'getBenchmarkAdapter',
  'getProviderAdapter',
  'getScorerAdapter',
  'hashFile',
  'hashObject',
  'isMissScore',
  'loadCaseCheckpoints',
  'mapWithConcurrency',
  'maxScorerCutoff',
  'mergeRuns',
  'missScoredCaseIds',
  'normalizeCitation',
  'normalizeScheduler',
  'normalizeTokenUsage',
  'providerAdapterId',
  'publishResultBundle',
  'rateLimitedProviderResult',
  'readApiRequestLimit',
  'readJson',
  'readJsonl',
  'readJsonlStream',
  'readRawJsonl',
  'reconstructFromRawRows',
  'reconstructPairFromRawRow',
  'registry',
  'relativePath',
  'retryFailed',
  'retryFailedRun',
  'retryableScoredCaseIds',
  'runOpenEvaluation',
  'scoreRawRows',
  'scoreRun',
  'scorerAdapterId',
  'sha256File',
  'sha256Text',
  'splitCitationList',
  'stableJson',
  'stripSyntheticInstructionPrefixes',
  'summarizeTokenUsage',
  'validateApiRequestLimitAgainstCutoffs',
  'validateScorerCutoffsMatchImplementation',
  'verifyResultBundle',
  'writeCaseCheckpoint',
  'writeCaseProgressCheckpoint',
  'writeJson',
  'writeJsonl',
  'writeText'
];

test('root barrel exposes exactly the declared public API surface', () => {
  const actual = Object.keys(publicApi).sort();
  const expected = [...EXPECTED_PUBLIC_EXPORTS].sort();
  assert.deepEqual(
    actual,
    expected,
    `Public API drift detected.\nAdded: ${actual.filter((k) => !expected.includes(k)).join(', ') || '(none)'}\nRemoved: ${expected.filter((k) => !actual.includes(k)).join(', ') || '(none)'}`
  );
});

test('every declared public export is defined (no undefined slots)', () => {
  for (const name of EXPECTED_PUBLIC_EXPORTS) {
    assert.notStrictEqual(
      publicApi[name],
      undefined,
      `public export '${name}' is undefined — did a re-export path break?`
    );
  }
});
