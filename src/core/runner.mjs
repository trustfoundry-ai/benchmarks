import path from 'node:path';

import {
  clearCheckpoints,
  loadCaseCheckpoints,
  writeCaseCheckpoint,
  writeCaseProgressCheckpoint
} from './checkpoints.mjs';
import {
  exists,
  readJson,
  readJsonl,
  readJsonlStream,
  relativePath,
  writeJson,
  writeJsonl,
  writeText
} from './fs.mjs';
import { assertCompatibleManifest, buildManifest } from './manifest.mjs';
import {
  createProviderRateLimiter,
  rateLimitedProviderResult
} from './rate-limit.mjs';
import { getAdapter } from './registry.mjs';
import { applyShard, mapWithConcurrency, normalizeScheduler } from './scheduler.mjs';
import { summarizeTokenUsage } from './token-usage.mjs';
import {
  SUPPORTED_CUTOFFS as SEARCH_RECALL_SUPPORTED_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF as SEARCH_RECALL_SUPPORTED_HEADLINE_CUTOFF
} from '../adapters/scorers/search-recall.mjs';

const DEFAULT_BENCHMARK_CONFIG = 'configs/benchmarks/trustfoundry-legal-search/case-questions-200.json';
const DEFAULT_PROVIDER_CONFIG = 'configs/providers/trustfoundry-legal-search.json';
const DEFAULT_SCORER_CONFIG = 'configs/scorers/trustfoundry-legal-search.json';
const DEFAULT_BENCHMARK_ADAPTER = 'trustfoundry-legal-search';
const DEFAULT_SCORER_ID = 'search-recall';

function nowCompact() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function maxScorerCutoff(scorerConfig = {}) {
  const cutoffs = Array.isArray(scorerConfig.cutoffs) ? scorerConfig.cutoffs : [];
  const headline = scorerConfig.headline_cutoff ?? scorerConfig.headlineCutoff;
  const candidates = [...cutoffs, headline]
    .map((value) => Number.parseInt(String(value ?? ''), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

export function readApiRequestLimit(scorerConfig = {}) {
  const raw = scorerConfig.api_request_limit ?? scorerConfig.apiRequestLimit;
  if (raw === undefined || raw === null) return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid api_request_limit ${JSON.stringify(raw)} in scorer config - must be a positive integer`
    );
  }
  return parsed;
}

function sameIntegerSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sortA = [...a].map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  const sortB = [...b].map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (sortA.length !== sortB.length) return false;
  return sortA.every((value, idx) => value === sortB[idx]);
}

export function validateScorerCutoffsMatchImplementation(
  scorerConfig = {},
  {
    supportedCutoffs = SEARCH_RECALL_SUPPORTED_CUTOFFS,
    supportedHeadlineCutoff = SEARCH_RECALL_SUPPORTED_HEADLINE_CUTOFF,
    scorerId = DEFAULT_SCORER_ID
  } = {}
) {
  const configuredCutoffs = scorerConfig.cutoffs;
  const configuredHeadline =
    scorerConfig.headline_cutoff ?? scorerConfig.headlineCutoff;

  if (configuredCutoffs !== undefined && !sameIntegerSet(configuredCutoffs, supportedCutoffs)) {
    throw new Error(
      `Scorer config invalid: cutoffs ${JSON.stringify(configuredCutoffs)} ` +
        `differs from the scorer's implementation ${JSON.stringify(supportedCutoffs)}. ` +
        `The result-bundle schema currently pins hits@K to these specific K values; ` +
        `update both src/adapters/scorers/${scorerId}.mjs and the artifact schema ` +
        `together to change them.`
    );
  }
  if (
    configuredHeadline !== undefined &&
    Number.parseInt(String(configuredHeadline), 10) !== supportedHeadlineCutoff
  ) {
    throw new Error(
      `Scorer config invalid: headline_cutoff ${configuredHeadline} ` +
        `differs from the scorer's implementation ${supportedHeadlineCutoff}.`
    );
  }
}

export function validateApiRequestLimitAgainstCutoffs(scorerConfig = {}) {
  const apiRequestLimit = readApiRequestLimit(scorerConfig);
  const maxCutoff = maxScorerCutoff(scorerConfig);
  if (apiRequestLimit === null || maxCutoff === null) return { apiRequestLimit, maxCutoff };
  if (apiRequestLimit < maxCutoff) {
    throw new Error(
      `Scorer config invalid: api_request_limit (${apiRequestLimit}) < ` +
        `max(cutoffs plus headline_cutoff) (${maxCutoff}). ` +
        `hits@${maxCutoff} cannot be satisfied because only ${apiRequestLimit} ` +
        `results are requested per call. Raise api_request_limit (subject to the ` +
        `public-api caller cap at https://api.trustfoundry.ai) or lower the ` +
        `largest cutoff/headline_cutoff.`
    );
  }
  return { apiRequestLimit, maxCutoff };
}

export function defaultPaths() {
  return {
    benchmarkConfig: DEFAULT_BENCHMARK_CONFIG,
    providerConfig: DEFAULT_PROVIDER_CONFIG,
    scorerConfig: DEFAULT_SCORER_CONFIG
  };
}

export function benchmarkAdapterId(config = {}) {
  return (
    config.benchmark_adapter ??
    config.benchmarkAdapter ??
    config.benchmark_id ??
    config.benchmarkId ??
    DEFAULT_BENCHMARK_ADAPTER
  );
}

// Resolves the scorer adapter id from the benchmark + scorer configs.
// Precedence: benchmarkConfig.scorer (or aliases) > scorerConfig.scorer (or
// aliases) > 'search-recall' (default). Existing configs that omit the
// scorer field continue to select search-recall unchanged.
export function scorerAdapterId(benchmarkConfig = {}, scorerConfig = {}) {
  return (
    benchmarkConfig.scorer ??
    benchmarkConfig.scorer_id ??
    benchmarkConfig.scorerId ??
    scorerConfig.scorer ??
    scorerConfig.scorer_id ??
    scorerConfig.id ??
    DEFAULT_SCORER_ID
  );
}

export function providerAdapterId(providerConfig = {}) {
  return (
    providerConfig.provider ??
    providerConfig.providerId ??
    'trustfoundry-public-search'
  );
}

function scorerConstants(scorerAdapter) {
  return {
    supportedCutoffs: scorerAdapter?.SUPPORTED_CUTOFFS ?? SEARCH_RECALL_SUPPORTED_CUTOFFS,
    supportedHeadlineCutoff:
      scorerAdapter?.SUPPORTED_HEADLINE_CUTOFF ?? SEARCH_RECALL_SUPPORTED_HEADLINE_CUTOFF
  };
}

async function loadOptionalJsonConfig(repoRoot, configPath) {
  if (!configPath) return { config: {}, absPath: null };
  const absPath = path.resolve(repoRoot, configPath);
  if (!(await exists(absPath))) return { config: {}, absPath: null };
  return { config: await readJson(absPath), absPath };
}

export async function loadRunInputs({
  repoRoot,
  benchmarkConfigPath = null,
  providerConfigPath = null,
  scorerConfigPath = null,
  limit = null,
  offset = null
}) {
  const benchmarkLoaded = await loadOptionalJsonConfig(repoRoot, benchmarkConfigPath);
  const providerLoaded = await loadOptionalJsonConfig(repoRoot, providerConfigPath);
  const scorerLoaded = await loadOptionalJsonConfig(repoRoot, scorerConfigPath);
  const benchmarkConfig = benchmarkLoaded.config;
  const providerConfig = providerLoaded.config;
  const scorerConfig = scorerLoaded.config;
  if (limit !== null) benchmarkConfig.limit = limit;
  if (offset !== null) benchmarkConfig.offset = offset;
  const scorerId = scorerAdapterId(benchmarkConfig, scorerConfig);
  const scorerAdapter = getAdapter('scorers', scorerId);
  const { supportedCutoffs, supportedHeadlineCutoff } = scorerConstants(scorerAdapter);
  validateScorerCutoffsMatchImplementation(scorerConfig, {
    supportedCutoffs,
    supportedHeadlineCutoff,
    scorerId
  });
  const { apiRequestLimit } = validateApiRequestLimitAgainstCutoffs(scorerConfig);
  if (apiRequestLimit !== null && providerConfig.limit === undefined) {
    providerConfig.limit = apiRequestLimit;
  }
  return {
    benchmarkConfig,
    providerConfig,
    scorerConfig,
    scorerId,
    scorerAdapter,
    paths: {
      benchmarkConfigFile: benchmarkLoaded.absPath,
      providerConfigFile: providerLoaded.absPath,
      scorerConfigFile: scorerLoaded.absPath,
      benchmarkConfigPath: benchmarkLoaded.absPath
        ? relativePath(repoRoot, benchmarkLoaded.absPath)
        : null,
      providerConfigPath: providerLoaded.absPath
        ? relativePath(repoRoot, providerLoaded.absPath)
        : null,
      scorerConfigPath: scorerLoaded.absPath
        ? relativePath(repoRoot, scorerLoaded.absPath)
        : null
    }
  };
}

async function writeArtifacts(artifacts, artifactBase) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return;
  for (const artifact of artifacts) {
    const relPath = artifact?.path;
    if (typeof relPath !== 'string' || !relPath) continue;
    if (relPath.includes('..')) {
      console.error(`skipping artifact with path traversal: ${relPath}`);
      continue;
    }
    const target = path.resolve(artifactBase, relPath);
    try {
      if (typeof artifact.content === 'string') {
        await writeText(target, artifact.content);
      } else if (artifact.content !== undefined && artifact.content !== null) {
        await writeText(target, String(artifact.content));
      }
    } catch (error) {
      console.error(`failed to write artifact ${relPath}: ${error.message}`);
    }
  }
}

export async function executeProviderCaseWithRetry({
  providerAdapter,
  benchmarkCase,
  config,
  outputRoot,
  retries = 0,
  rateLimiter = null
}) {
  const startedAt = new Date().toISOString();
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const acquisition = rateLimiter ? await rateLimiter.acquire() : null;
      if (acquisition && !acquisition.allowed) {
        return {
          ...rateLimitedProviderResult(benchmarkCase, acquisition),
          retryMetadata: {
            attempts: attempt,
            maxRetries: retries,
            startedAt
          }
        };
      }
      const result = await providerAdapter.executeCase({
        benchmarkCase,
        config,
        outputRoot,
        attempt
      });
      await rateLimiter?.noteProviderResult(result);
      return {
        ...result,
        providerMetadata: {
          ...(result.providerMetadata ?? {}),
          ...(acquisition?.rateLimit ? { rateLimit: acquisition.rateLimit } : {})
        },
        retryMetadata: {
          attempts: attempt + 1,
          maxRetries: retries,
          startedAt
        }
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
    }
  }
  return {
    caseId: benchmarkCase.caseId,
    status: 'provider_failure',
    rawOutput: {
      error: {
        kind: 'unhandled_error',
        message: lastError instanceof Error ? lastError.message : String(lastError)
      }
    },
    finalOutputText: JSON.stringify({
      query: benchmarkCase.prompt ?? '',
      results: [],
      result_count: 0
    }),
    artifacts: [],
    providerMetadata: { error: 'unhandled_error' },
    timing: { startedAt, completedAt: new Date().toISOString(), durationMs: null },
    tokenUsage: null,
    retryMetadata: {
      attempts: retries + 1,
      maxRetries: retries,
      startedAt
    },
    error: {
      kind: 'unhandled_error',
      message: lastError instanceof Error ? lastError.message : String(lastError)
    }
  };
}

function unsupportedProviderResult(benchmarkCase) {
  return {
    caseId: benchmarkCase.caseId,
    status: 'unsupported',
    rawOutput: null,
    finalOutputText: '',
    artifacts: [],
    providerMetadata: null,
    timing: null,
    tokenUsage: null,
    retryMetadata: null,
    error: {
      message: 'Benchmark case is unsupported by this harness/provider configuration',
      reasons: benchmarkCase.unsupportedReasons ?? []
    }
  };
}

function selectedInventorySummary(inventory) {
  return {
    benchmark: inventory?.benchmark ?? null,
    sourceRoot: inventory?.sourceRoot ?? null,
    summary: inventory?.summary ?? null,
    records: inventory?.records ?? []
  };
}

function buildPreflight({ manifest, inventory, allCases, shardCases }) {
  return {
    runId: manifest.runId,
    benchmark: manifest.benchmark,
    provider: manifest.provider,
    scorer: manifest.scorer,
    inventory: selectedInventorySummary(inventory),
    cases: {
      total: allCases.length,
      shard: shardCases.length,
      skippedByShard: allCases.length - shardCases.length
    },
    scheduler: manifest.scheduler
  };
}

function completedForResume(result) {
  return ['completed', 'unsupported'].includes(result?.status);
}

export function buildReport({
  manifest,
  preflight,
  scores,
  providerResults,
  cases = []
}) {
  const byStatus = {};
  for (const result of providerResults) {
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
  }
  const tokenUsage = summarizeTokenUsage({ cases, providerResults });
  return {
    runId: manifest.runId,
    benchmark: manifest.benchmark,
    provider: manifest.provider,
    scorer: manifest.scorer,
    scheduler: manifest.scheduler,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    fingerprints: manifest.fingerprints,
    preflight,
    providerResults: {
      total: providerResults.length,
      byStatus
    },
    tokenUsage,
    scores: scores?.summary ?? null,
    scorerStatus: scores?.status ?? null
  };
}

export async function executeRun({
  repoRoot = process.cwd(),
  outDir = null,
  outputRoot = null,
  benchmarkConfigPath = null,
  providerConfigPath = null,
  scorerConfigPath = null,
  benchmarkId = null,
  providerId = null,
  scorerId = null,
  limit = null,
  offset = null,
  parallel = 4,
  shardIndex = 0,
  shardCount = 1,
  retries = 0,
  runId = null,
  runKind = 'execution',
  force = false,
  resume = false,
  progress = true,
  includeHostname = false
}) {
  const resolvedOut = outputRoot
    ? path.resolve(repoRoot, outputRoot)
    : outDir
      ? path.resolve(repoRoot, outDir)
      : null;
  if (!resolvedOut) throw new Error('executeRun requires --out (or outputRoot/outDir)');
  if (resume && force) throw new Error('Use only one of --resume or --force');

  const inputs = await loadRunInputs({
    repoRoot,
    benchmarkConfigPath,
    providerConfigPath,
    scorerConfigPath,
    limit,
    offset
  });
  const resolvedBenchmarkId = benchmarkId ?? benchmarkAdapterId(inputs.benchmarkConfig);
  const resolvedProviderId = providerId ?? providerAdapterId(inputs.providerConfig);
  const resolvedScorerId = scorerId ?? inputs.scorerId ?? DEFAULT_SCORER_ID;
  const benchmarkAdapter = getAdapter('benchmarks', resolvedBenchmarkId);
  const providerAdapter = getAdapter('providers', resolvedProviderId);
  const scorerAdapter = getAdapter('scorers', resolvedScorerId);

  const loaded = await benchmarkAdapter.loadCases({
    config: inputs.benchmarkConfig,
    repoRoot
  });
  const providerDescription = await providerAdapter.describe({
    config: inputs.providerConfig
  });
  const scorerDescription = scorerAdapter.describe
    ? await scorerAdapter.describe({ config: inputs.scorerConfig })
    : { id: resolvedScorerId };
  const scheduler = normalizeScheduler({ parallel, shardIndex, shardCount, retries });
  const allCases = loaded.cases;
  const shardCases = applyShard(allCases, scheduler);

  const effectiveRunId =
    runId ?? `${resolvedBenchmarkId}-${providerDescription.subject ?? resolvedProviderId}-${nowCompact()}`;

  const manifest = await buildManifest({
    repoRoot,
    runId: effectiveRunId,
    runKind,
    benchmark: loaded.benchmark,
    benchmarkConfig: inputs.benchmarkConfig,
    providerDescription,
    scorerDescription,
    paths: inputs.paths,
    parallel: scheduler.parallel,
    shardIndex: scheduler.shardIndex,
    shardCount: scheduler.shardCount,
    retries: scheduler.retries,
    caseCount: shardCases.length,
    scorerId: resolvedScorerId,
    includeHostname
  });

  const manifestPath = path.join(resolvedOut, 'manifest.json');
  if ((await exists(manifestPath)) && !resume && !force) {
    throw new Error(
      `Output manifest already exists: ${manifestPath}. Use --resume or --force.`
    );
  }
  if (force) await clearCheckpoints({ outputRoot: resolvedOut });
  if (resume && (await exists(manifestPath))) {
    assertCompatibleManifest(await readJson(manifestPath), manifest, {
      requireResume: true
    });
  }

  await writeJson(manifestPath, manifest);
  await writeJson(path.join(resolvedOut, 'inventory.json'), loaded.inventory);
  await writeJson(
    path.join(resolvedOut, 'preflight.json'),
    buildPreflight({
      manifest,
      inventory: loaded.inventory,
      allCases,
      shardCases
    })
  );
  await writeJsonl(path.join(resolvedOut, 'cases.jsonl'), shardCases);

  const resumeCheckpoints = resume
    ? await loadCaseCheckpoints({
        outputRoot: resolvedOut,
        manifestFingerprint: manifest.fingerprints.resume
      })
    : [];
  const resumedByCaseId = new Map(
    resumeCheckpoints
      .map((checkpoint) => checkpoint.providerResult)
      .filter(completedForResume)
      .map((result) => [result.caseId, { ...result, resumed: true }])
  );

  const providerRateLimiter = createProviderRateLimiter({
    config: inputs.providerConfig,
    providerId: resolvedProviderId,
    repoRoot
  });

  const providerResults = [];
  let lastProgressAt = Date.now();
  await mapWithConcurrency(shardCases, scheduler.parallel, async (benchmarkCase) => {
    const resumedResult = resumedByCaseId.get(benchmarkCase.caseId);
    let providerResult;
    if (resumedResult) {
      providerResult = resumedResult;
    } else if (benchmarkCase.unsupported) {
      providerResult = unsupportedProviderResult(benchmarkCase);
    } else {
      providerResult = await executeProviderCaseWithRetry({
        providerAdapter,
        benchmarkCase,
        config: inputs.providerConfig,
        outputRoot: resolvedOut,
        retries: scheduler.retries,
        rateLimiter: providerRateLimiter
      });
    }
    await writeArtifacts(providerResult.artifacts, resolvedOut);
    providerResults.push(providerResult);
    await writeCaseCheckpoint({
      outputRoot: resolvedOut,
      manifestFingerprint: manifest.fingerprints.resume,
      benchmarkCase,
      providerResult
    });
    await writeCaseProgressCheckpoint({
      outputRoot: resolvedOut,
      manifest,
      cases: shardCases,
      providerResults
    });
    if (progress) {
      const now = Date.now();
      if (providerResults.length === shardCases.length || now - lastProgressAt >= 10000) {
        lastProgressAt = now;
        console.error(`progress ${providerResults.length}/${shardCases.length}`);
      }
    }
  });

  providerResults.sort((left, right) => left.caseId.localeCompare(right.caseId));
  await writeJsonl(path.join(resolvedOut, 'provider-results.jsonl'), providerResults);

  const scores = await scorerAdapter.score({
    manifest,
    cases: shardCases,
    providerResults,
    outputRoot: resolvedOut,
    config: inputs.scorerConfig
  });
  await writeJson(path.join(resolvedOut, 'scores.json'), scores);

  const completedManifest = {
    ...manifest,
    completedAt: new Date().toISOString(),
    providerFailures: providerResults.filter((result) => result.status !== 'completed').length
  };
  await writeJson(manifestPath, completedManifest);
  const report = buildReport({
    manifest: completedManifest,
    preflight: buildPreflight({
      manifest: completedManifest,
      inventory: loaded.inventory,
      allCases,
      shardCases
    }),
    scores,
    providerResults,
    cases: shardCases
  });
  await writeJson(path.join(resolvedOut, 'report.json'), report);
  await writeJson(path.join(resolvedOut, 'token-usage.json'), report.tokenUsage);
  const parent = path.dirname(resolvedOut);
  if (parent && parent !== resolvedOut) {
    await writeJson(path.join(parent, 'latest.json'), {
      generatedAt: new Date().toISOString(),
      runId: completedManifest.runId,
      runPath: resolvedOut,
      report
    });
  }

  return {
    outDir: resolvedOut,
    manifest: completedManifest,
    inventory: loaded.inventory,
    preflight: report.preflight,
    providerResults,
    scores,
    report
  };
}

// Backwards-compat alias for callers migrating from private's runOpenEvaluation.
export const runOpenEvaluation = executeRun;

// Streams provider-results.jsonl through the scorer, looking up each row's
// case in the pre-loaded cases map. Used by scoreRun.
async function scoreFromDisk({ scorerAdapter, manifest, cases, providerResultsPath }) {
  const casesById = new Map(cases.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase]));
  async function* pairs() {
    for await (const providerResult of readJsonlStream(providerResultsPath)) {
      const benchmarkCase = casesById.get(providerResult.caseId);
      if (!benchmarkCase) {
        throw new Error(`Provider result references unknown case: ${providerResult.caseId}`);
      }
      yield { benchmarkCase, providerResult };
    }
  }
  return scorerAdapter.scoreStream({ manifest, pairs: pairs() });
}

// mergeRuns lives in ./merge.mjs; re-exported here so existing imports
// (`import { mergeRuns } from '.../core/runner.mjs'`) keep working.
export { mergeRuns } from './merge.mjs';

export async function scoreRun({ repoRoot, runDir }) {
  const resolvedRun = path.resolve(repoRoot, runDir);
  const manifest = await readJson(path.join(resolvedRun, 'manifest.json'));
  const cases = await readJsonl(path.join(resolvedRun, 'cases.jsonl'));
  const scorerAdapter = getAdapter('scorers', manifest.scorer?.id ?? DEFAULT_SCORER_ID);
  const scores = await scoreFromDisk({
    scorerAdapter,
    manifest,
    cases,
    providerResultsPath: path.join(resolvedRun, 'provider-results.jsonl')
  });
  await writeJson(path.join(resolvedRun, 'scores.json'), scores);
  return scores;
}
