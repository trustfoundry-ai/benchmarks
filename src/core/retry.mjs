/**
 * Reissue misses from a completed run into a new run directory.
 *
 * Reference implementation of retry-failed for benchmark harnesses.
 * Loads the source run (`manifest.json`, `cases.jsonl`,
 * `provider-results.jsonl`, `scores.json`), selects cases matching the
 * caller-supplied `filter`, and re-executes them against the same
 * provider adapter. The retry run lands in `outDir` with a manifest
 * that carries `runKind: 'retry-failed'` and a `sourceRuns` entry
 * pointing back at the source. `assertCompatibleManifest` is used to
 * refuse a retry when the source and the new provider/scorer describe
 * disagree, so the retry cannot silently mix runs with different inputs.
 *
 * The default filter reissues any case whose provider status is not
 * `completed`, or (when scores are present) whose scored `score` is
 * less than 1.0.
 */
import path from 'node:path';

import {
  exists,
  readJson,
  readJsonl,
  relativePath,
  writeJson,
  writeJsonl
} from './fs.mjs';
import { assertCompatibleManifest, computeFingerprints } from './manifest.mjs';
import { getAdapter } from './registry.mjs';
import {
  createProviderRateLimiter,
  rateLimitedProviderResult
} from './rate-limit.mjs';

const DEFAULT_SCORER_ID = 'search-recall';

function nowCompact() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Default filter — retry a case if it never completed OR if it scored
// less than 1.0. Consumers can pass their own filter that receives
// { providerResult, caseScore } and returns true to include the case.
export function defaultRetryFilter({ providerResult, caseScore }) {
  if (!providerResult || providerResult.status !== 'completed') return true;
  if (
    caseScore &&
    typeof caseScore.score === 'number' &&
    caseScore.score < 1
  ) {
    return true;
  }
  return false;
}

function selectRetryCases({ cases, providerResults, scores, filter }) {
  const resultByCaseId = new Map(providerResults.map((r) => [r.caseId, r]));
  const scoreByCaseId = new Map(
    (scores?.caseScores ?? []).map((s) => [s.caseId, s])
  );
  return cases.filter((benchmarkCase) => {
    const providerResult = resultByCaseId.get(benchmarkCase.caseId) ?? null;
    const caseScore = scoreByCaseId.get(benchmarkCase.caseId) ?? null;
    return filter({ benchmarkCase, providerResult, caseScore });
  });
}

async function executeCase({
  providerAdapter,
  benchmarkCase,
  providerConfig,
  rateLimiter
}) {
  if (rateLimiter) {
    const acquisition = await rateLimiter.acquire();
    if (!acquisition.allowed) {
      return rateLimitedProviderResult(benchmarkCase, acquisition);
    }
  }
  try {
    const result = await providerAdapter.executeCase({
      benchmarkCase,
      config: providerConfig
    });
    if (rateLimiter) await rateLimiter.noteProviderResult(result);
    return result;
  } catch (error) {
    return {
      caseId: benchmarkCase.caseId,
      status: 'provider_failure',
      rawOutput: { error: { kind: 'unhandled_error', message: error.message } },
      finalOutputText: JSON.stringify({
        query: benchmarkCase.prompt ?? '',
        results: [],
        result_count: 0
      }),
      artifacts: [],
      providerMetadata: { error: 'unhandled_error' },
      timing: { startedAt: null, completedAt: null, durationMs: null },
      tokenUsage: null,
      retryMetadata: null,
      error: { kind: 'unhandled_error', message: error.message }
    };
  }
}

export async function retryFailed({
  repoRoot = process.cwd(),
  runDir,
  outDir,
  filter = defaultRetryFilter,
  parallel = 4,
  force = false,
  runId = null
}) {
  if (!runDir) throw new Error('retryFailed requires a runDir');
  if (!outDir) throw new Error('retryFailed requires an outDir');

  const resolvedRun = path.resolve(repoRoot, runDir);
  const resolvedOut = path.resolve(repoRoot, outDir);
  if ((await exists(resolvedOut)) && !force) {
    throw new Error(
      `Output directory already exists: ${resolvedOut}. Use --force to overwrite.`
    );
  }

  const sourceManifest = await readJson(path.join(resolvedRun, 'manifest.json'));
  const cases = await readJsonl(path.join(resolvedRun, 'cases.jsonl'));
  const providerResults = await readJsonl(
    path.join(resolvedRun, 'provider-results.jsonl')
  );
  let scores = null;
  try {
    scores = await readJson(path.join(resolvedRun, 'scores.json'));
  } catch {
    scores = null;
  }

  const retryCases = selectRetryCases({ cases, providerResults, scores, filter });
  if (retryCases.length === 0) {
    throw new Error(
      `retryFailed: no cases matched the filter in ${resolvedRun} — nothing to retry.`
    );
  }

  const providerId = sourceManifest.provider?.id;
  if (!providerId) {
    throw new Error(
      `retryFailed: source manifest at ${resolvedRun} has no provider.id`
    );
  }
  const providerAdapter = getAdapter('providers', providerId);
  // The provider config lives on disk at source manifest's configPath.
  const providerConfigPath = path.resolve(repoRoot, sourceManifest.provider.configPath);
  const providerConfig = await readJson(providerConfigPath);
  const providerDescription = await providerAdapter.describe({ config: providerConfig });

  const scorerId = sourceManifest.scorer?.id ?? DEFAULT_SCORER_ID;
  const scorerAdapter = getAdapter('scorers', scorerId);

  const retryRunId = runId ?? `retry-${nowCompact()}`;
  const retryManifestBase = {
    ...sourceManifest,
    runId: retryRunId,
    run_id: retryRunId,
    runKind: 'retry-failed',
    provider: {
      ...sourceManifest.provider,
      ...providerDescription
    },
    scheduler: {
      ...(sourceManifest.scheduler ?? {}),
      parallel: parsePositiveInteger(parallel, 4),
      caseCount: retryCases.length
    },
    startedAt: new Date().toISOString(),
    completedAt: null,
    sourceRuns: [
      {
        runId: sourceManifest.runId ?? sourceManifest.run_id ?? null,
        runDir: relativePath(repoRoot, resolvedRun)
      }
    ]
  };
  const retryManifest = {
    ...retryManifestBase,
    fingerprints: computeFingerprints(retryManifestBase)
  };
  assertCompatibleManifest(sourceManifest, retryManifest);

  await writeJson(path.join(resolvedOut, 'manifest.json'), retryManifest);
  await writeJsonl(path.join(resolvedOut, 'cases.jsonl'), retryCases);

  const rateLimiter = createProviderRateLimiter({
    config: providerConfig,
    providerId,
    repoRoot
  });

  // Simple bounded-concurrency loop — small enough here that duplicating
  // it is preferable to wiring runner.mjs internals through.
  const results = new Array(retryCases.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < retryCases.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await executeCase({
        providerAdapter,
        benchmarkCase: retryCases[index],
        providerConfig,
        rateLimiter
      });
    }
  }
  const workers = Math.min(retryManifest.scheduler.parallel, retryCases.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const providerResultsPath = path.join(resolvedOut, 'provider-results.jsonl');
  await writeJsonl(providerResultsPath, results);

  const retryScores = await scorerAdapter.scoreStream({
    manifest: retryManifest,
    pairs: (async function* () {
      for (let index = 0; index < retryCases.length; index += 1) {
        yield { benchmarkCase: retryCases[index], providerResult: results[index] };
      }
    })()
  });
  await writeJson(path.join(resolvedOut, 'scores.json'), retryScores);

  retryManifest.completedAt = new Date().toISOString();
  await writeJson(path.join(resolvedOut, 'manifest.json'), retryManifest);

  return {
    outDir: resolvedOut,
    manifest: retryManifest,
    caseCount: retryCases.length,
    scores: retryScores
  };
}
