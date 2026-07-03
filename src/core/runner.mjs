import path from 'node:path';

import {
  createJsonlWriter,
  exists,
  readJson,
  readJsonl,
  readJsonlStream,
  relativePath,
  sha256File,
  writeJson,
  writeJsonl,
  writeText
} from './fs.mjs';
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

// Merges N chunk runs into one canonical run directory: concatenates
// cases.jsonl and provider-results.jsonl across chunks (last-wins dedup by
// caseId, so a same-day retry chunk overrides a quota_exhausted row from
// an earlier chunk), copies the first chunk's manifest with chunks: [...]
// metadata, and re-scores. Refuses to merge chunks whose benchmark or
// provider config sha256 disagree — that would silently mix runs that used
// different inputs.
export async function mergeRuns({ repoRoot, runDirs, outDir, force = false }) {
  if (!Array.isArray(runDirs) || runDirs.length === 0) {
    throw new Error('mergeRuns requires at least one input run directory');
  }
  const resolvedOut = path.resolve(repoRoot, outDir);
  if ((await exists(resolvedOut)) && !force) {
    throw new Error(`Output directory already exists: ${resolvedOut}. Use --force to overwrite.`);
  }

  const chunks = [];
  for (const runDir of runDirs) {
    const resolved = path.resolve(repoRoot, runDir);
    const manifest = await readJson(path.join(resolved, 'manifest.json'));
    chunks.push({ runDir: resolved, manifest });
  }

  const first = chunks[0].manifest;
  const firstBenchmarkSha = first.benchmark?.configSha256 ?? null;
  const firstProviderSha = first.provider?.configSha256 ?? null;
  const firstScorerSha = first.scorer?.configSha256 ?? null;
  for (const { runDir, manifest } of chunks) {
    if ((manifest.benchmark?.configSha256 ?? null) !== firstBenchmarkSha) {
      throw new Error(
        `Chunk ${runDir} has benchmark config sha256 ${manifest.benchmark?.configSha256} ` +
          `but expected ${firstBenchmarkSha} — refusing to merge across different benchmark configs.`
      );
    }
    if ((manifest.provider?.configSha256 ?? null) !== firstProviderSha) {
      throw new Error(
        `Chunk ${runDir} has provider config sha256 ${manifest.provider?.configSha256} ` +
          `but expected ${firstProviderSha} — refusing to merge across different provider configs.`
      );
    }
    if ((manifest.scorer?.configSha256 ?? null) !== firstScorerSha) {
      throw new Error(
        `Chunk ${runDir} has scorer config sha256 ${manifest.scorer?.configSha256} ` +
          `but expected ${firstScorerSha} — refusing to merge across different scorer configs.`
      );
    }
  }

  const casesById = new Map();
  const resultsById = new Map();
  const inventoryRecords = [];
  for (const { runDir } of chunks) {
    const chunkCases = await readJsonl(path.join(runDir, 'cases.jsonl'));
    for (const benchmarkCase of chunkCases) {
      if (!casesById.has(benchmarkCase.caseId)) casesById.set(benchmarkCase.caseId, benchmarkCase);
    }
    const chunkResults = await readJsonl(path.join(runDir, 'provider-results.jsonl'));
    for (const providerResult of chunkResults) {
      resultsById.set(providerResult.caseId, providerResult);
    }
    const inventoryPath = path.join(runDir, 'inventory.json');
    if (await exists(inventoryPath)) {
      const inventory = await readJson(inventoryPath);
      if (Array.isArray(inventory.records)) inventoryRecords.push(...inventory.records);
    }
  }

  const mergedCases = [...casesById.values()];
  const mergedResults = [...resultsById.values()];
  let providerFailures = 0;
  for (const providerResult of mergedResults) {
    if (providerResult.status !== 'completed') providerFailures += 1;
  }

  const runId = `merge-${nowCompact()}`;
  const mergedManifest = {
    ...first,
    runId,
    run_id: runId,
    startedAt: chunks.reduce(
      (min, chunk) => (min && min < chunk.manifest.startedAt ? min : chunk.manifest.startedAt),
      null
    ),
    completedAt: chunks.reduce(
      (max, chunk) => (max && max > (chunk.manifest.completedAt ?? '') ? max : chunk.manifest.completedAt),
      null
    ),
    providerFailures,
    scheduler: {
      ...(first.scheduler ?? {}),
      caseCount: mergedCases.length
    },
    chunks: chunks.map(({ runDir, manifest }) => ({
      runDir: relativePath(repoRoot, runDir),
      runId: manifest.runId ?? manifest.run_id ?? null,
      startedAt: manifest.startedAt ?? null,
      completedAt: manifest.completedAt ?? null,
      caseCount: manifest.scheduler?.caseCount ?? null
    }))
  };

  await writeJsonl(path.join(resolvedOut, 'cases.jsonl'), mergedCases);
  const providerResultsPath = path.join(resolvedOut, 'provider-results.jsonl');
  await writeJsonl(providerResultsPath, mergedResults);
  await writeJson(path.join(resolvedOut, 'manifest.json'), mergedManifest);
  if (inventoryRecords.length) {
    await writeJson(path.join(resolvedOut, 'inventory.json'), {
      benchmark: first.benchmark?.id ?? null,
      records: inventoryRecords,
      summary: { total: mergedCases.length, selected: mergedCases.length, available_skipped: 0 }
    });
  }

  const scorerAdapter = getAdapter('scorers', 'search-recall');
  const scores = await scoreFromDisk({
    scorerAdapter,
    manifest: mergedManifest,
    cases: mergedCases,
    providerResultsPath
  });
  await writeJson(path.join(resolvedOut, 'scores.json'), scores);

  return {
    outDir: resolvedOut,
    manifest: mergedManifest,
    scores,
    caseCount: mergedCases.length,
    chunkCount: chunks.length
  };
}

export async function scoreRun({ repoRoot, runDir }) {
  const resolvedRun = path.resolve(repoRoot, runDir);
  const manifest = await readJson(path.join(resolvedRun, 'manifest.json'));
  const cases = await readJsonl(path.join(resolvedRun, 'cases.jsonl'));
  const scorerAdapter = getAdapter('scorers', 'search-recall');
  const scores = await scoreFromDisk({
    scorerAdapter,
    manifest,
    cases,
    providerResultsPath: path.join(resolvedRun, 'provider-results.jsonl')
  });
  await writeJson(path.join(resolvedRun, 'scores.json'), scores);
  return scores;
}
