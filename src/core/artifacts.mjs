import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createGunzip, createGzip, gunzip } from 'node:zlib';

import {
  canonicalStringify,
  createJsonlWriter,
  exists,
  readJson,
  readJsonl,
  readJsonlStream,
  relativePath,
  sha256File,
  writeJson,
  writeText
} from './fs.mjs';
import { getAdapter } from './registry.mjs';

const LARGE_RAW_GZIP_THRESHOLD_BYTES = 95 * 1024 * 1024;
const gunzipAsync = promisify(gunzip);

function safeParseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonlText(text, file) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${error.message}`);
      }
    });
}

async function readRawJsonl(file) {
  if (!file.endsWith('.gz')) return readJsonl(file);
  const inflated = await gunzipAsync(await readFile(file));
  return parseJsonlText(inflated.toString('utf8'), file);
}

// Streaming JSONL reader that transparently handles gzipped bundles. Used by
// verifyResultBundle so a 5k-row bundle never has to be materialized.
// Buffers chunks manually and splits on \n rather than going through
// readline — readline's async iterator on a piped gunzip stream in Node 24
// returns truncated "lines" for long records (~14KB), corrupting parses.
async function* readRawJsonlStream(file) {
  if (!file.endsWith('.gz')) {
    yield* readJsonlStream(file);
    return;
  }
  const input = createReadStream(file).pipe(createGunzip());
  input.setEncoding('utf8');
  let buffer = '';
  let lineNumber = 0;
  for await (const chunk of input) {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${file}:${lineNumber}: ${error.message}`);
      }
    }
  }
  if (buffer.trim()) {
    lineNumber += 1;
    try {
      yield JSON.parse(buffer);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${file}:${lineNumber}: ${error.message}`);
    }
  }
}

async function gzipFile(source, target) {
  await pipeline(
    createReadStream(source),
    createGzip({ level: 9 }),
    createWriteStream(target)
  );
}

function normalizedResults(providerResult) {
  const parsed = safeParseJson(providerResult.finalOutputText);
  return Array.isArray(parsed?.results)
    ? parsed.results
    : Array.isArray(providerResult.rawOutput?.normalizedResults)
      ? providerResult.rawOutput.normalizedResults
      : [];
}

// Builds a single raw-row record from one case + its provider result + its
// score. Pure; safe to call in a streaming pipeline. The field set is the
// raw-row.v1 schema — keep it in sync with reconstructPairFromRawRow.
export function buildRawRow({ benchmarkCase, providerResult, caseScore }) {
  const parsed = safeParseJson(providerResult?.finalOutputText) ?? {};
  return {
    schema_version: 'trustfoundry.benchmarks.raw-row.v1',
    case_id: benchmarkCase.caseId,
    benchmark_id: benchmarkCase.benchmarkId ?? null,
    row_index: benchmarkCase.metadata?.datasetIndex ?? null,
    split: benchmarkCase.split ?? null,
    dataset_name: benchmarkCase.metadata?.datasetName ?? null,
    prompt: benchmarkCase.prompt ?? '',
    metadata: {
      doc_type: benchmarkCase.metadata?.doc_type ?? null,
      field: benchmarkCase.metadata?.field ?? null,
      model_type: benchmarkCase.metadata?.model_type ?? null,
      datasource_id: benchmarkCase.metadata?.datasource_id ?? null,
      authority_identifier: benchmarkCase.metadata?.authority_identifier ?? null,
      jurisdiction_id: benchmarkCase.metadata?.jurisdiction_id ?? null
    },
    expected: {
      document_uuid: benchmarkCase.metadata?.document_uuid ?? null,
      canonical_citation: benchmarkCase.metadata?.expected?.canonical_citation ?? null,
      alternates: benchmarkCase.metadata?.expected?.alternates ?? [],
      document_title: benchmarkCase.metadata?.document_title ?? null,
      state: benchmarkCase.metadata?.state ?? null,
      source_index: benchmarkCase.metadata?.source_index ?? null
    },
    request: providerResult?.rawOutput?.request ?? null,
    response: {
      provider_status: providerResult?.status ?? 'missing',
      http_status:
        providerResult?.providerMetadata?.httpStatus ?? providerResult?.rawOutput?.httpStatus ?? null,
      error: providerResult?.error ?? null,
      result_count: parsed.result_count ?? normalizedResults(providerResult ?? {}).length,
      total_available: parsed.total_available ?? providerResult?.providerMetadata?.totalAvailable ?? null,
      set_uuid: parsed.set_uuid ?? null,
      results: normalizedResults(providerResult ?? {})
    },
    timing: {
      duration_ms: providerResult?.timing?.durationMs ?? null,
      ttfb_ms: providerResult?.timing?.ttfbMs ?? providerResult?.providerMetadata?.ttfbMs ?? null,
      stream_duration_ms: providerResult?.timing?.streamDurationMs ?? null,
      started_at: providerResult?.timing?.startedAt ?? null,
      completed_at: providerResult?.timing?.completedAt ?? null
    },
    score: {
      status: caseScore?.status ?? null,
      hit_rank: caseScore?.hitRank ?? null,
      hit_at_1: caseScore?.hitAt1 ?? false,
      hit_at_5: caseScore?.hitAt5 ?? false,
      hit_at_10: caseScore?.hitAt10 ?? false,
      hit_at_25: caseScore?.hitAt25 ?? false,
      reciprocal_rank: caseScore?.reciprocalRank ?? 0
    }
  };
}

// Backward-compat array form. Prefer streaming via buildRawRow + a writer
// when row counts are large.
export function buildRawRows({ cases, providerResults, caseScores }) {
  const providerByCase = new Map(providerResults.map((row) => [row.caseId, row]));
  const scoreByCase = new Map(caseScores.map((score) => [score.caseId, score]));
  return cases.map((benchmarkCase) =>
    buildRawRow({
      benchmarkCase,
      providerResult: providerByCase.get(benchmarkCase.caseId) ?? null,
      caseScore: scoreByCase.get(benchmarkCase.caseId) ?? null
    })
  );
}

// Reconstructs the (case, provider-result) pair needed by the scorer from a
// single raw row. Pure; safe to call in a streaming verify pipeline. Keep
// field defaults in sync with buildRawRow above.
export function reconstructPairFromRawRow(row) {
  const benchmarkCase = {
    caseId: row.case_id,
    benchmarkId: row.benchmark_id ?? 'trustfoundry-legal-search',
    split: row.split,
    prompt: row.prompt,
    metadata: {
      datasetIndex: row.row_index,
      datasetName: row.dataset_name,
      doc_type: row.metadata?.doc_type ?? 'case',
      field: row.metadata?.field ?? 'questions',
      model_type: row.metadata?.model_type ?? row.request?.model_type ?? 'case_question',
      datasource_id: row.metadata?.datasource_id ?? null,
      authority_identifier: row.metadata?.authority_identifier ?? null,
      jurisdiction_id: row.metadata?.jurisdiction_id ?? null,
      state: row.expected?.state ?? row.request?.state ?? null,
      document_uuid: row.expected?.document_uuid ?? null,
      expected: {
        kind: 'exact',
        canonical_citation: row.expected?.canonical_citation ?? null,
        alternates: row.expected?.alternates ?? []
      }
    }
  };
  const providerResult = {
    caseId: row.case_id,
    status: row.response?.provider_status === 'completed' ? 'completed' : 'provider_failure',
    finalOutputText: JSON.stringify({
      query: row.request?.query ?? row.prompt ?? '',
      result_count: row.response?.result_count ?? 0,
      total_available: row.response?.total_available ?? null,
      set_uuid: row.response?.set_uuid ?? null,
      results: row.response?.results ?? []
    }),
    timing: { durationMs: row.timing?.duration_ms ?? null },
    error: row.response?.error ?? null
  };
  return { benchmarkCase, providerResult };
}

// Backward-compat array form.
export function reconstructFromRawRows(rawRows) {
  const cases = [];
  const providerResults = [];
  for (const row of rawRows) {
    const pair = reconstructPairFromRawRow(row);
    cases.push(pair.benchmarkCase);
    providerResults.push(pair.providerResult);
  }
  return { cases, providerResults };
}

// Streams raw rows through the scorer; never materializes more than one pair
// in memory at a time. Returns the same shape as scorer.score().
async function scoreRawRowsStream({ rawRowsIterable, manifest = null }) {
  const scorer = getAdapter('scorers', 'search-recall');
  async function* pairs() {
    for await (const row of rawRowsIterable) {
      yield reconstructPairFromRawRow(row);
    }
  }
  return scorer.scoreStream({ manifest, pairs: pairs() });
}

// Backward-compat array form. Prefer scoreRawRowsStream for large bundles.
export async function scoreRawRows({ rawRows, manifest = null }) {
  async function* asIterable() {
    for (const row of rawRows) yield row;
  }
  return scoreRawRowsStream({ rawRowsIterable: asIterable(), manifest });
}

function resultEnvelope({ manifest, scores }) {
  return {
    schema_version: 'trustfoundry.benchmarks.result.v1',
    status: 'self-reported',
    generated_at: new Date().toISOString(),
    run: {
      run_id: manifest.run_id ?? manifest.runId ?? null,
      harness: manifest.harness ?? null,
      benchmark: manifest.benchmark ?? null,
      provider: manifest.provider ?? null,
      scheduler: manifest.scheduler ?? null
    },
    summary: scores.summary,
    metadata: scores.metadata
  };
}

export async function publishResultBundle({ repoRoot, runDir, outDir, force = false }) {
  const resolvedRun = path.resolve(repoRoot, runDir);
  const resolvedOut = path.resolve(repoRoot, outDir);
  if ((await exists(resolvedOut)) && !force) {
    throw new Error(`Output directory already exists: ${resolvedOut}. Use --force to overwrite.`);
  }
  const manifest = await readJson(path.join(resolvedRun, 'manifest.json'));
  const casesPath = path.join(resolvedRun, 'cases.jsonl');
  const providerResultsPath = path.join(resolvedRun, 'provider-results.jsonl');

  // Cases are small (metadata + prompt, no big response payloads). Pre-load
  // them into a map for O(1) lookup. ~1KB per case → ~5MB at 5k cases.
  const cases = await readJsonl(casesPath);
  const casesById = new Map(cases.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase]));

  // Stream provider-results through the scorer; build + write each raw row as
  // its case score is produced. Only one pair lives in memory at a time.
  let rawArtifactPath = 'raw.jsonl';
  let rawPath = path.join(resolvedOut, rawArtifactPath);
  const rawWriter = await createJsonlWriter(rawPath);
  let rowCount = 0;

  async function* providerPairs() {
    for await (const providerResult of readJsonlStream(providerResultsPath)) {
      const benchmarkCase = casesById.get(providerResult.caseId);
      if (!benchmarkCase) {
        throw new Error(`Provider result references unknown case: ${providerResult.caseId}`);
      }
      yield { benchmarkCase, providerResult };
    }
  }

  const scorer = getAdapter('scorers', 'search-recall');
  const scoreResult = await scorer.scoreStream({
    manifest,
    pairs: providerPairs(),
    onCaseScored: async ({ benchmarkCase, providerResult, caseScore }) => {
      const rawRow = buildRawRow({ benchmarkCase, providerResult, caseScore });
      await rawWriter.write(rawRow);
      rowCount += 1;
    }
  });
  await rawWriter.close();

  if ((await stat(rawPath)).size > LARGE_RAW_GZIP_THRESHOLD_BYTES) {
    const gzPath = path.join(resolvedOut, 'raw.jsonl.gz');
    await gzipFile(rawPath, gzPath);
    await unlink(rawPath);
    rawArtifactPath = 'raw.jsonl.gz';
    rawPath = gzPath;
  }

  const result = resultEnvelope({ manifest, scores: scoreResult });
  const resultPath = path.join(resolvedOut, 'result.json');
  await writeJson(resultPath, result);

  const bundleManifest = {
    schema_version: 'trustfoundry.benchmarks.result-manifest.v1',
    generated_at: new Date().toISOString(),
    status: 'self-reported',
    source_run_id: manifest.run_id ?? manifest.runId ?? null,
    artifacts: {
      raw: {
        path: rawArtifactPath,
        sha256: await sha256File(rawPath),
        rows: rowCount
      },
      result: {
        path: 'result.json',
        sha256: await sha256File(resultPath)
      }
    },
    verification_inputs: {
      benchmark_config: {
        path: manifest.benchmark?.configPath ?? null,
        sha256: manifest.benchmark?.configSha256 ?? null
      },
      provider_config: {
        path: manifest.provider?.configPath ?? null,
        sha256: manifest.provider?.configSha256 ?? null
      },
      scorer_config: {
        path: manifest.scorer?.configPath ?? null,
        sha256: manifest.scorer?.configSha256 ?? null
      },
      data_files: manifest.benchmark?.sourceFiles ?? []
    }
  };
  const manifestPath = path.join(resolvedOut, 'manifest.json');
  await writeJson(manifestPath, bundleManifest);
  const checksums = [
    `${bundleManifest.artifacts.raw.sha256}  ${rawArtifactPath}`,
    `${bundleManifest.artifacts.result.sha256}  result.json`,
    `${await sha256File(manifestPath)}  manifest.json`
  ].join('\n');
  await writeText(path.join(resolvedOut, 'checksums.txt'), `${checksums}\n`);
  return { outDir: resolvedOut, manifest: bundleManifest, result };
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

async function verifyInputDigest(repoRoot, item, label) {
  if (!item?.path || !item?.sha256) return;
  const file = path.resolve(repoRoot, item.path);
  if (!(await exists(file))) throw new Error(`${label} not found: ${item.path}`);
  assertEqual(await sha256File(file), item.sha256, `${label} digest mismatch`);
}

export async function verifyResultBundle({ repoRoot, bundleDir, verifyInputs = true }) {
  const resolvedBundle = path.resolve(repoRoot, bundleDir);
  const manifest = await readJson(path.join(resolvedBundle, 'manifest.json'));
  const rawPath = path.join(resolvedBundle, manifest.artifacts?.raw?.path ?? 'raw.jsonl');
  const resultPath = path.join(resolvedBundle, manifest.artifacts?.result?.path ?? 'result.json');
  assertEqual(await sha256File(rawPath), manifest.artifacts.raw.sha256, `${manifest.artifacts.raw.path} digest mismatch`);
  assertEqual(await sha256File(resultPath), manifest.artifacts.result.sha256, 'result.json digest mismatch');

  const result = await readJson(resultPath);

  // Stream raw rows through the scorer; count rows as they go so we can
  // verify against the manifest's row count without materializing the file.
  let rowCount = 0;
  async function* countingRawRows() {
    for await (const row of readRawJsonlStream(rawPath)) {
      rowCount += 1;
      yield row;
    }
  }
  const recomputed = await scoreRawRowsStream({
    rawRowsIterable: countingRawRows(),
    manifest: result.run
      ? {
          run_id: result.run.run_id,
          benchmark: result.run.benchmark,
          provider: result.run.provider,
          scheduler: result.run.scheduler
        }
      : null
  });
  assertEqual(rowCount, manifest.artifacts.raw.rows, 'raw row count mismatch');
  const recomputedSummary = canonicalStringify(recomputed.summary);
  const reportedSummary = canonicalStringify(result.summary);
  assertEqual(reportedSummary, recomputedSummary, 'result summary mismatch');

  if (verifyInputs) {
    await verifyInputDigest(repoRoot, manifest.verification_inputs?.benchmark_config, 'benchmark config');
    await verifyInputDigest(repoRoot, manifest.verification_inputs?.provider_config, 'provider config');
    await verifyInputDigest(repoRoot, manifest.verification_inputs?.scorer_config, 'scorer config');
    for (const dataFile of manifest.verification_inputs?.data_files ?? []) {
      await verifyInputDigest(repoRoot, dataFile, `data file ${dataFile.path}`);
    }
  }
  return {
    ok: true,
    bundleDir: relativePath(repoRoot, resolvedBundle),
    rows: rowCount,
    summary: result.summary
  };
}

// Kept for callers (tests + tooling) that still want to read a whole bundle
// into memory. Prefer readRawJsonlStream + the streaming verifier for large
// bundles.
export { readRawJsonl };
