import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  'Z95',
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
  'gitDirty',
  'gitRevision',
  'hashFile',
  'hashObject',
  'isMissScore',
  'listSuites',
  'loadCaseCheckpoints',
  'mapWithConcurrency',
  'maxScorerCutoff',
  'mergeRuns',
  'missScoredCaseIds',
  'normalizeCitation',
  'normalizeScheduler',
  'normalizeTokenUsage',
  'parseTargetRef',
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
  'resolveTarget',
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
  'wilsonInterval',
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

// `src/index.d.mts` is the package's published `types` entry point
// (see package.json's `"types"` field and the `"."` export condition), and
// its own header says it is kept in lockstep with this runtime barrel. A
// value declared with `export declare function/const/class` in that file
// is a runtime binding a TypeScript consumer expects to import with types;
// `export interface` / `export type` are pure type-level exports that have
// no runtime counterpart and are intentionally excluded from this
// comparison. Both sides below are derived — the runtime side from the
// barrel itself, the declared side from the .d.mts file's own text — so
// nothing here is a third hardcoded list that could itself drift.
test('src/index.d.mts declares exactly the runtime barrel\'s exports', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dts = await readFile(path.join(root, 'src/index.d.mts'), 'utf8');
  const declared = new Set();
  for (const match of dts.matchAll(/^export declare (?:function|const|class) (\w+)/gm)) {
    declared.add(match[1]);
  }
  assert.ok(declared.size > 0, 'no `export declare` bindings found — the parse regex may be stale');

  const runtime = new Set(Object.keys(publicApi));
  const missingFromTypes = [...runtime].filter((name) => !declared.has(name)).sort();
  const missingFromRuntime = [...declared].filter((name) => !runtime.has(name)).sort();
  assert.deepEqual(
    { missingFromTypes, missingFromRuntime },
    { missingFromTypes: [], missingFromRuntime: [] },
    'src/index.d.mts and src/index.mjs disagree on the exported name set'
  );
});
