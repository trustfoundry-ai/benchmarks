import path from 'node:path';

import {
  createJsonlWriter,
  exists,
  readJson,
  readJsonl,
  readJsonlStream,
  relativePath,
  writeJson,
  writeJsonl,
  writeText
} from './fs.mjs';
import { buildManifest } from './manifest.mjs';
import { getAdapter } from './registry.mjs';
import {
  SUPPORTED_CUTOFFS as SEARCH_RECALL_SUPPORTED_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF as SEARCH_RECALL_SUPPORTED_HEADLINE_CUTOFF
} from '../adapters/scorers/search-recall.mjs';

const DEFAULT_BENCHMARK_CONFIG = 'configs/benchmarks/trustfoundry-legal-search-case-questions-200.json';
const DEFAULT_PROVIDER_CONFIG = 'configs/providers/trustfoundry-public-search.json';
const DEFAULT_SCORER_CONFIG = 'configs/scorers/search-recall.json';
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

function scorerConstants(scorerAdapter) {
  return {
    supportedCutoffs: scorerAdapter?.SUPPORTED_CUTOFFS ?? SEARCH_RECALL_SUPPORTED_CUTOFFS,
    supportedHeadlineCutoff:
      scorerAdapter?.SUPPORTED_HEADLINE_CUTOFF ?? SEARCH_RECALL_SUPPORTED_HEADLINE_CUTOFF
  };
}

export async function loadRunInputs({
  repoRoot,
  benchmarkConfigPath = DEFAULT_BENCHMARK_CONFIG,
  providerConfigPath = DEFAULT_PROVIDER_CONFIG,
  scorerConfigPath = DEFAULT_SCORER_CONFIG,
  limit = null,
  offset = null
}) {
  const benchmarkConfigFile = path.resolve(repoRoot, benchmarkConfigPath);
  const providerConfigFile = path.resolve(repoRoot, providerConfigPath);
  const scorerConfigFile = path.resolve(repoRoot, scorerConfigPath);
  const benchmarkConfig = await readJson(benchmarkConfigFile);
  const providerConfig = await readJson(providerConfigFile);
  const scorerConfig = await readJson(scorerConfigFile);
  if (limit !== null) benchmarkConfig.limit = limit;
  if (offset !== null) benchmarkConfig.offset = offset;
  // Resolve the scorer adapter before validating cutoffs — the validator
  // consults the selected scorer's exported SUPPORTED_CUTOFFS /
  // SUPPORTED_HEADLINE_CUTOFF, not a global constant.
  const scorerId = scorerAdapterId(benchmarkConfig, scorerConfig);
  const scorerAdapter = getAdapter('scorers', scorerId);
  const { supportedCutoffs, supportedHeadlineCutoff } = scorerConstants(scorerAdapter);
  // Validate the scorer config: its cutoffs must match the scorer's
  // implementation (the result-bundle schema currently pins hits@K), and
  // api_request_limit must be >= the largest hits@K cutoff. See
  // configs/scorers/<scorerId>.json for the rationale and the link to the
  // public-api caller cap at https://api.trustfoundry.ai.
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
      benchmarkConfigFile,
      providerConfigFile,
      scorerConfigFile,
      benchmarkConfigPath: relativePath(repoRoot, benchmarkConfigFile),
      providerConfigPath: relativePath(repoRoot, providerConfigFile),
      scorerConfigPath: relativePath(repoRoot, scorerConfigFile)
    }
  };
}

// Runs `worker` for each item with bounded concurrency, streaming each
// result to disk as it completes (rather than buffering all results in
// memory). JSONL output is in completion order; downstream consumers look
// up cases by caseId so order does not matter. Returns counts only.
//
// Per-case artifacts: if `result.artifacts` is populated, each entry is
// materialized to `<outputDir>/<artifact.path>` so providers can persist
// verbatim upstream responses (e.g. the CL adapter saves raw API bodies
// to raw-responses/*.json for offline reprocessing without spending API
// quota). Artifact writes are best-effort; a failed write logs a warning
// but does not fail the case.
async function runParallelToDisk({ items, parallel, worker, onProgress, outputPath, outputDir }) {
  const writer = await createJsonlWriter(outputPath);
  const artifactBase = outputDir ?? path.dirname(outputPath);
  // Serialize writes via a chained promise — Node's writeStream is atomic
  // per call, but chaining gives clean backpressure across workers without
  // any explicit mutex bookkeeping.
  let writeChain = Promise.resolve();
  function writeRow(row) {
    const next = writeChain.then(() => writer.write(row));
    writeChain = next.catch(() => {});
    return next;
  }

  async function writeArtifacts(artifacts) {
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

  let next = 0;
  let completed = 0;
  let providerFailures = 0;

  async function loop() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      let result;
      try {
        result = await worker(items[index], index);
      } catch (error) {
        result = {
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
      if (result.status !== 'completed') providerFailures += 1;
      await writeArtifacts(result.artifacts);
      await writeRow(result);
      completed += 1;
      onProgress?.({ completed, total: items.length });
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, loop));
  await writer.close();
  return { completed, providerFailures };
}

export async function executeRun({
  repoRoot,
  outDir,
  benchmarkConfigPath = DEFAULT_BENCHMARK_CONFIG,
  providerConfigPath = DEFAULT_PROVIDER_CONFIG,
  scorerConfigPath = DEFAULT_SCORER_CONFIG,
  limit = null,
  offset = null,
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
    limit,
    offset
  });
  const benchmarkAdapter = getAdapter('benchmarks', benchmarkAdapterId(inputs.benchmarkConfig));
  const providerId =
    inputs.providerConfig.provider ??
    inputs.providerConfig.providerId ??
    'trustfoundry-public-search';
  const providerAdapter = getAdapter('providers', providerId);
  const scorerAdapter = inputs.scorerAdapter;
  const loaded = await benchmarkAdapter.loadCases({
    config: inputs.benchmarkConfig,
    repoRoot
  });
  const providerDescription = await providerAdapter.describe({ config: inputs.providerConfig });
  const schedulerParallel = parsePositiveInteger(parallel, 4);
  const manifest = await buildManifest({
    repoRoot,
    runId,
    benchmark: loaded.benchmark,
    benchmarkConfig: inputs.benchmarkConfig,
    providerDescription,
    paths: inputs.paths,
    parallel: schedulerParallel,
    caseCount: loaded.cases.length,
    scorerId: inputs.scorerId ?? DEFAULT_SCORER_ID
  });

  await writeJson(path.join(resolvedOut, 'manifest.json'), manifest);
  await writeJson(path.join(resolvedOut, 'inventory.json'), loaded.inventory);
  await writeJsonl(path.join(resolvedOut, 'cases.jsonl'), loaded.cases);

  const providerResultsPath = path.join(resolvedOut, 'provider-results.jsonl');
  let lastProgressAt = Date.now();
  const { providerFailures } = await runParallelToDisk({
    items: loaded.cases,
    parallel: schedulerParallel,
    worker: (benchmarkCase) =>
      providerAdapter.executeCase({ benchmarkCase, config: inputs.providerConfig }),
    onProgress: ({ completed, total }) => {
      if (!progress) return;
      const now = Date.now();
      if (completed === total || now - lastProgressAt >= 10000) {
        lastProgressAt = now;
        console.error(`progress ${completed}/${total}`);
      }
    },
    outputPath: providerResultsPath,
    outputDir: resolvedOut
  });

  manifest.completedAt = new Date().toISOString();
  manifest.providerFailures = providerFailures;
  await writeJson(path.join(resolvedOut, 'manifest.json'), manifest);

  // Stream-score from the just-written provider-results.jsonl. Cases stay in
  // memory (loaded.cases) — they're small (no big response payloads).
  const scores = await scoreFromDisk({
    scorerAdapter,
    manifest,
    cases: loaded.cases,
    providerResultsPath
  });
  await writeJson(path.join(resolvedOut, 'scores.json'), scores);

  return {
    outDir: resolvedOut,
    manifest,
    inventory: loaded.inventory,
    scores
  };
}

// Streams provider-results.jsonl through the scorer, looking up each row's
// case in the pre-loaded cases map. Used by both executeRun and scoreRun.
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
