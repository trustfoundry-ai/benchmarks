/**
 * Reissue misses from a completed run into a new run directory.
 *
 * Reference implementation of retry-failed for benchmark harnesses.
 * Loads the source run (`manifest.json`, `cases.jsonl`,
 * `provider-results.jsonl`, `scores.json`), selects cases matching either
 * a caller-supplied `filter` callback or the built-in `selection` policy
 * (`'failed'` retries non-completed provider results plus scored
 * unscorables; `'misses'` retries any case whose score was less than
 * perfect), and re-executes them against the same provider adapter. The
 * retry run lands in `outDir` with a manifest that carries
 * `runKind: 'retry-failed'` or `runKind: 'retry-misses'` and a
 * `sourceRuns` entry pointing back at the source.
 * `assertCompatibleManifest` refuses a retry when the source and the new
 * provider/scorer describe disagree, so the retry cannot silently mix
 * runs with different inputs.
 */
import path from 'node:path';

import {
  clearCheckpoints,
  writeCaseCheckpoint,
  writeCaseProgressCheckpoint
} from './checkpoints.mjs';
import {
  exists,
  readJson,
  readJsonl,
  relativePath,
  writeJson,
  writeJsonl
} from './fs.mjs';
import { assertCompatibleManifest, computeFingerprints } from './manifest.mjs';
import { createProviderRateLimiter } from './rate-limit.mjs';
import { getAdapter } from './registry.mjs';
import { buildReport, executeProviderCaseWithRetry } from './runner.mjs';
import { mapWithConcurrency, normalizeScheduler } from './scheduler.mjs';

const DEFAULT_SCORER_ID = 'search-recall';

const RETRYABLE_STATUSES = new Set([
  'provider_error',
  'provider_failure',
  'unscorable',
  'needs_confirmation',
  'stopped',
  'partial',
  'error',
  'rate_limited'
]);

function nowCompact() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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

function isRetryableResult(result) {
  return !result || RETRYABLE_STATUSES.has(result.status);
}

function scoreCaseId(score) {
  return score?.caseId ?? score?.exampleId ?? null;
}

export function retryableScoredCaseIds(scores) {
  const retryable = new Set();
  for (const score of scores?.caseScores ?? scores?.examples ?? []) {
    if (score?.status === 'unscorable' || score?.status === 'provider_failure') {
      const caseId = scoreCaseId(score);
      if (caseId) retryable.add(caseId);
    }
  }
  return retryable;
}

export function isMissScore(score) {
  if (!score) return false;
  if (
    score.status === 'unsupported' ||
    score.status === 'unscorable' ||
    score.status === 'provider_failure' ||
    score.unscorableGeneration === true
  ) {
    return true;
  }
  if (score.correct === false) return true;
  if (typeof score.score === 'number') return score.score < 1;
  return false;
}

export function missScoredCaseIds(scores) {
  const misses = new Set();
  for (const score of scores?.caseScores ?? scores?.examples ?? []) {
    if (!isMissScore(score)) continue;
    const caseId = scoreCaseId(score);
    if (caseId) misses.add(caseId);
  }
  return misses;
}

export function casesForRetrySelection({
  cases,
  providerResults,
  previousScores,
  selection
}) {
  const resultByCaseId = new Map(providerResults.map((result) => [result.caseId, result]));
  if (selection === 'misses') {
    const missCaseIds = missScoredCaseIds(previousScores);
    return cases.filter((benchmarkCase) => missCaseIds.has(benchmarkCase.caseId));
  }
  const scoredRetryable = retryableScoredCaseIds(previousScores);
  return cases.filter(
    (benchmarkCase) =>
      isRetryableResult(resultByCaseId.get(benchmarkCase.caseId)) ||
      scoredRetryable.has(benchmarkCase.caseId)
  );
}

function selectRetryCasesWithFilter({ cases, providerResults, scores, filter }) {
  const resultByCaseId = new Map(providerResults.map((result) => [result.caseId, result]));
  const scoreByCaseId = new Map(
    (scores?.caseScores ?? []).map((score) => [score.caseId, score])
  );
  return cases.filter((benchmarkCase) => {
    const providerResult = resultByCaseId.get(benchmarkCase.caseId) ?? null;
    const caseScore = scoreByCaseId.get(benchmarkCase.caseId) ?? null;
    return filter({ benchmarkCase, providerResult, caseScore });
  });
}

export async function retryFailedRun({
  repoRoot = process.cwd(),
  runDir,
  outDir = null,
  outputRoot = null,
  providerConfigPath = null,
  scorerConfigPath = null,
  filter = null,
  selection = 'failed',
  parallel = 4,
  retries = 0,
  force = false,
  runId = null
}) {
  if (!runDir) throw new Error('retryFailedRun requires --run');
  const resolvedOut = outputRoot
    ? path.resolve(repoRoot, outputRoot)
    : outDir
      ? path.resolve(repoRoot, outDir)
      : null;
  if (!resolvedOut) throw new Error('retryFailedRun requires --out (or outputRoot/outDir)');
  if (filter === null && !['failed', 'misses'].includes(selection)) {
    throw new Error(`Invalid retry selection '${selection}'`);
  }

  const resolvedRun = path.resolve(repoRoot, runDir);
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
  let previousScores = null;
  try {
    previousScores = await readJson(path.join(resolvedRun, 'scores.json'));
  } catch {
    previousScores = null;
  }

  const retryCases = filter
    ? selectRetryCasesWithFilter({
        cases,
        providerResults,
        scores: previousScores,
        filter
      })
    : casesForRetrySelection({
        cases,
        providerResults,
        previousScores,
        selection
      });
  if (retryCases.length === 0) {
    throw new Error(
      `retryFailedRun: no cases matched the ${filter ? 'filter' : `'${selection}' selection`} in ${resolvedRun} — nothing to retry.`
    );
  }

  const providerId = sourceManifest.provider?.id;
  if (!providerId) {
    throw new Error(`retryFailedRun: source manifest has no provider.id`);
  }
  const providerAdapter = getAdapter('providers', providerId);
  const providerConfigResolved =
    providerConfigPath ?? sourceManifest.provider.configPath;
  const providerConfig = providerConfigResolved
    ? await readJson(path.resolve(repoRoot, providerConfigResolved))
    : {};
  const providerDescription = await providerAdapter.describe({
    config: providerConfig
  });

  const scorerId = sourceManifest.scorer?.id ?? DEFAULT_SCORER_ID;
  const scorerAdapter = getAdapter('scorers', scorerId);
  const scorerConfigResolved =
    scorerConfigPath ?? sourceManifest.scorer?.configPath ?? null;
  const scorerConfig = scorerConfigResolved
    ? await readJson(path.resolve(repoRoot, scorerConfigResolved))
    : {};

  const scheduler = normalizeScheduler({ parallel, retries });
  const retryKind =
    !filter && selection === 'misses' ? 'retry-misses' : 'retry-failed';
  const retryRunId =
    runId ??
    `${sourceManifest.runId ?? sourceManifest.run_id ?? 'run'}-${retryKind}-${nowCompact()}`;

  const retryManifestBase = {
    ...sourceManifest,
    runId: retryRunId,
    run_id: retryRunId,
    runKind: retryKind,
    provider: {
      ...sourceManifest.provider,
      ...providerDescription
    },
    scheduler: {
      ...(sourceManifest.scheduler ?? {}),
      parallel: scheduler.parallel,
      shardIndex: sourceManifest.scheduler?.shardIndex ?? 0,
      shardCount: sourceManifest.scheduler?.shardCount ?? 1,
      retries: scheduler.retries,
      caseCount: retryCases.length
    },
    startedAt: new Date().toISOString(),
    completedAt: null,
    sourceRuns: [
      {
        runId: sourceManifest.runId ?? sourceManifest.run_id ?? null,
        runDir: relativePath(repoRoot, resolvedRun),
        ...(filter ? {} : { selection })
      }
    ]
  };
  const retryManifest = {
    ...retryManifestBase,
    fingerprints: computeFingerprints(retryManifestBase)
  };
  assertCompatibleManifest(sourceManifest, retryManifest);

  if (force) await clearCheckpoints({ outputRoot: resolvedOut });

  await writeJson(path.join(resolvedOut, 'manifest.json'), retryManifest);
  await writeJsonl(path.join(resolvedOut, 'cases.jsonl'), retryCases);

  const rateLimiter = createProviderRateLimiter({
    config: providerConfig,
    providerId,
    repoRoot
  });

  const results = [];
  await mapWithConcurrency(retryCases, scheduler.parallel, async (benchmarkCase) => {
    const providerResult = await executeProviderCaseWithRetry({
      providerAdapter,
      benchmarkCase,
      config: providerConfig,
      outputRoot: resolvedOut,
      retries: scheduler.retries,
      rateLimiter
    });
    results.push(providerResult);
    await writeCaseCheckpoint({
      outputRoot: resolvedOut,
      manifestFingerprint: retryManifest.fingerprints.resume,
      benchmarkCase,
      providerResult
    });
    await writeCaseProgressCheckpoint({
      outputRoot: resolvedOut,
      manifest: retryManifest,
      cases: retryCases,
      providerResults: results
    });
  });

  results.sort((left, right) => left.caseId.localeCompare(right.caseId));
  await writeJsonl(path.join(resolvedOut, 'provider-results.jsonl'), results);

  const scores = await scorerAdapter.score({
    manifest: retryManifest,
    cases: retryCases,
    providerResults: results,
    outputRoot: resolvedOut,
    config: scorerConfig
  });
  await writeJson(path.join(resolvedOut, 'scores.json'), scores);

  const completedManifest = {
    ...retryManifest,
    completedAt: new Date().toISOString()
  };
  await writeJson(path.join(resolvedOut, 'manifest.json'), completedManifest);
  const report = buildReport({
    manifest: completedManifest,
    preflight: null,
    scores,
    providerResults: results,
    cases: retryCases
  });
  await writeJson(path.join(resolvedOut, 'report.json'), report);
  await writeJson(path.join(resolvedOut, 'token-usage.json'), report.tokenUsage);

  return {
    outDir: resolvedOut,
    manifest: completedManifest,
    cases: retryCases,
    providerResults: results,
    scores,
    report,
    caseCount: retryCases.length
  };
}

// Backwards-compat alias — public code paths that imported `retryFailed`
// from './retry.mjs' get the same entrypoint.
export const retryFailed = retryFailedRun;
