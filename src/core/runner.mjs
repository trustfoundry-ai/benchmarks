import path from 'node:path';

import { exists, readJson, relativePath, sha256File, writeJson, writeJsonl } from './fs.mjs';
import { getAdapter } from './registry.mjs';
import {
  SUPPORTED_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF
} from '../adapters/scorers/search-recall.mjs';

const DEFAULT_BENCHMARK_CONFIG = 'configs/benchmarks/trustfoundry-legal-search-case-questions-200.json';
const DEFAULT_PROVIDER_CONFIG = 'configs/providers/trustfoundry-public-search.json';
const DEFAULT_SCORER_CONFIG = 'configs/scorers/search-recall.json';
const DEFAULT_BENCHMARK_ADAPTER = 'trustfoundry-legal-search';

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

export function validateScorerCutoffsMatchImplementation(scorerConfig = {}) {
  const configuredCutoffs = scorerConfig.cutoffs;
  const configuredHeadline =
    scorerConfig.headline_cutoff ?? scorerConfig.headlineCutoff;

  if (configuredCutoffs !== undefined && !sameIntegerSet(configuredCutoffs, SUPPORTED_CUTOFFS)) {
    throw new Error(
      `Scorer config invalid: cutoffs ${JSON.stringify(configuredCutoffs)} ` +
        `differs from the scorer's implementation ${JSON.stringify(SUPPORTED_CUTOFFS)}. ` +
        `The result-bundle schema currently pins hits@K to these specific K values; ` +
        `update both src/adapters/scorers/search-recall.mjs and the artifact schema ` +
        `together to change them.`
    );
  }
  if (
    configuredHeadline !== undefined &&
    Number.parseInt(String(configuredHeadline), 10) !== SUPPORTED_HEADLINE_CUTOFF
  ) {
    throw new Error(
      `Scorer config invalid: headline_cutoff ${configuredHeadline} ` +
        `differs from the scorer's implementation ${SUPPORTED_HEADLINE_CUTOFF}.`
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

async function gitCommit(repoRoot) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
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

export async function loadRunInputs({
  repoRoot,
  benchmarkConfigPath = DEFAULT_BENCHMARK_CONFIG,
  providerConfigPath = DEFAULT_PROVIDER_CONFIG,
  scorerConfigPath = DEFAULT_SCORER_CONFIG,
  limit = null
}) {
  const benchmarkConfigFile = path.resolve(repoRoot, benchmarkConfigPath);
  const providerConfigFile = path.resolve(repoRoot, providerConfigPath);
  const scorerConfigFile = path.resolve(repoRoot, scorerConfigPath);
  const benchmarkConfig = await readJson(benchmarkConfigFile);
  const providerConfig = await readJson(providerConfigFile);
  const scorerConfig = await readJson(scorerConfigFile);
  if (limit !== null) benchmarkConfig.limit = limit;
  // Validate the scorer config: its cutoffs must match the scorer's
  // implementation (the result-bundle schema currently pins hits@K), and
  // api_request_limit must be >= the largest hits@K cutoff. See
  // configs/scorers/search-recall.json for the rationale and the link to the
  // public-api caller cap at https://api.trustfoundry.ai.
  validateScorerCutoffsMatchImplementation(scorerConfig);
  const { apiRequestLimit } = validateApiRequestLimitAgainstCutoffs(scorerConfig);
  if (apiRequestLimit !== null && providerConfig.limit === undefined) {
    providerConfig.limit = apiRequestLimit;
  }
  return {
    benchmarkConfig,
    providerConfig,
    scorerConfig,
    paths: {
      benchmarkConfigFile,
      providerConfigFile,
      scorerConfigFile,
      benchmarkConfigPath: relativePath(repoRoot, benchmarkConfigFile),
      providerConfigPath: relativePath(repoRoot, providerConfigFile),
      scorerConfigPath: relativePath(repoRoot, scorerConfigFile)
    }
  };
}

async function createManifest({
  repoRoot,
  runId,
  benchmark,
  benchmarkConfig,
  providerDescription,
  paths,
  parallel,
  caseCount
}) {
  const sourceFiles = benchmark.sourceFiles ?? [];
  const dataFiles = await Promise.all(
    sourceFiles.map(async (file) => ({
      path: relativePath(repoRoot, file),
      sha256: await sha256File(file)
    }))
  );
  return {
    schema_version: 'trustfoundry.benchmarks.run.v1',
    runId,
    run_id: runId,
    harness: {
      name: '@trustfoundry-ai/benchmarks',
      commit: await gitCommit(repoRoot)
    },
    benchmark: {
      id: benchmark.id,
      version: benchmark.version,
      configPath: paths.benchmarkConfigPath,
      configSha256: await sha256File(paths.benchmarkConfigFile),
      sourceRoot: relativePath(repoRoot, benchmark.sourceRoot),
      sourceFiles: dataFiles,
      datasetSize: benchmarkConfig.datasetSize ?? null,
      datasetNames: benchmarkConfig.datasetNames ?? null,
      splits: benchmarkConfig.splits ?? null,
      queryTransformId: benchmark.queryTransformId ?? null
    },
    provider: {
      ...providerDescription,
      configPath: paths.providerConfigPath,
      configSha256: await sha256File(paths.providerConfigFile)
    },
    scorer: {
      id: 'search-recall',
      configPath: paths.scorerConfigPath,
      configSha256: await sha256File(paths.scorerConfigFile)
    },
    scheduler: {
      parallel,
      caseCount
    },
    startedAt: new Date().toISOString()
  };
}

async function runParallel(items, parallel, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function loop() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          caseId: items[index].caseId,
          status: 'provider_failure',
          rawOutput: { error: { kind: 'unhandled_error', message: error.message } },
          finalOutputText: JSON.stringify({ query: items[index].prompt ?? '', results: [], result_count: 0 }),
          artifacts: [],
          providerMetadata: { error: 'unhandled_error' },
          timing: { startedAt: null, completedAt: null, durationMs: null },
          tokenUsage: null,
          retryMetadata: null,
          error: { kind: 'unhandled_error', message: error.message }
        };
      }
      completed += 1;
      onProgress?.({ completed, total: items.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, loop));
  return results;
}

export async function executeRun({
  repoRoot,
  outDir,
  benchmarkConfigPath = DEFAULT_BENCHMARK_CONFIG,
  providerConfigPath = DEFAULT_PROVIDER_CONFIG,
  scorerConfigPath = DEFAULT_SCORER_CONFIG,
  limit = null,
  parallel = 4,
  runId = `public-search-${nowCompact()}`,
  force = false,
  progress = true
}) {
  const resolvedOut = path.resolve(repoRoot, outDir);
  if ((await exists(resolvedOut)) && !force) {
    throw new Error(`Output directory already exists: ${resolvedOut}. Use --force to overwrite.`);
  }
  const inputs = await loadRunInputs({
    repoRoot,
    benchmarkConfigPath,
    providerConfigPath,
    scorerConfigPath,
    limit
  });
  const benchmarkAdapter = getAdapter('benchmarks', benchmarkAdapterId(inputs.benchmarkConfig));
  const providerAdapter = getAdapter('providers', 'trustfoundry-public-search');
  const scorerAdapter = getAdapter('scorers', 'search-recall');
  const loaded = await benchmarkAdapter.loadCases({
    config: inputs.benchmarkConfig,
    repoRoot
  });
  const providerDescription = await providerAdapter.describe({ config: inputs.providerConfig });
  const schedulerParallel = parsePositiveInteger(parallel, 4);
  const manifest = await createManifest({
    repoRoot,
    runId,
    benchmark: loaded.benchmark,
    benchmarkConfig: inputs.benchmarkConfig,
    providerDescription,
    paths: inputs.paths,
    parallel: schedulerParallel,
    caseCount: loaded.cases.length
  });

  await writeJson(path.join(resolvedOut, 'manifest.json'), manifest);
  await writeJson(path.join(resolvedOut, 'inventory.json'), loaded.inventory);
  await writeJsonl(path.join(resolvedOut, 'cases.jsonl'), loaded.cases);

  let lastProgressAt = Date.now();
  const providerResults = await runParallel(
    loaded.cases,
    schedulerParallel,
    (benchmarkCase) => providerAdapter.executeCase({
      benchmarkCase,
      config: inputs.providerConfig
    }),
    ({ completed, total }) => {
      if (!progress) return;
      const now = Date.now();
      if (completed === total || now - lastProgressAt >= 10000) {
        lastProgressAt = now;
        console.error(`progress ${completed}/${total}`);
      }
    }
  );
  await writeJsonl(path.join(resolvedOut, 'provider-results.jsonl'), providerResults);

  manifest.completedAt = new Date().toISOString();
  manifest.providerFailures = providerResults.filter((item) => item.status !== 'completed').length;
  await writeJson(path.join(resolvedOut, 'manifest.json'), manifest);

  const scores = await scorerAdapter.score({
    manifest,
    cases: loaded.cases,
    providerResults,
    config: inputs.scorerConfig
  });
  await writeJson(path.join(resolvedOut, 'scores.json'), scores);

  return {
    outDir: resolvedOut,
    manifest,
    inventory: loaded.inventory,
    scores
  };
}

export async function scoreRun({ repoRoot, runDir }) {
  const resolvedRun = path.resolve(repoRoot, runDir);
  const manifest = await readJson(path.join(resolvedRun, 'manifest.json'));
  const cases = await import('./fs.mjs').then((mod) => mod.readJsonl(path.join(resolvedRun, 'cases.jsonl')));
  const providerResults = await import('./fs.mjs').then((mod) => mod.readJsonl(path.join(resolvedRun, 'provider-results.jsonl')));
  const scorerAdapter = getAdapter('scorers', 'search-recall');
  const scores = await scorerAdapter.score({ manifest, cases, providerResults });
  await writeJson(path.join(resolvedRun, 'scores.json'), scores);
  return scores;
}
