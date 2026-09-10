import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
// raw-row.v2 schema — keep it in sync with reconstructPairFromRawRow.
//
// Additive fields (missing on older bundles → null on reconstruction) support
// benchmark-specific stratifications without a schema version bump:
// `metadata.document_type`, `metadata.difficulty`, `metadata.kind`,
// `metadata.negative_category`, `metadata.geo_level_2`, and
// `expected.kind` / `expected.negative_category` for citation-lookup.
//
// `cutoffs` is required: it is the scorer's own configured cutoff list (read
// from `summary.execution.scorer.cutoffs`, the one path both scorers report
// it at), and `score.hit_at` is keyed by exactly those values. There is no
// default -- a scorer's cutoffs are not something this function can guess,
// and guessing here is how a published row silently drops or fabricates a
// hit@K metric.
export function buildRawRow({
  benchmarkCase,
  providerResult,
  caseScore,
  publishedExpectedFields = [],
  cutoffs
}) {
  if (!Array.isArray(cutoffs) || cutoffs.length === 0) {
    throw new Error(
      "buildRawRow: 'cutoffs' is required (the scorer's configured cutoffs, e.g. from " +
        'summary.execution.scorer.cutoffs) and must be a non-empty array; received ' +
        `${JSON.stringify(cutoffs)}`
    );
  }

  const expectedSource = benchmarkCase.metadata?.expected ?? {};
  const publishedExpected = {};
  for (const field of publishedExpectedFields) {
    if (expectedSource[field] !== undefined) publishedExpected[field] = expectedSource[field];
  }

  const parsed = safeParseJson(providerResult?.finalOutputText) ?? {};
  return {
    schema_version: 'trustfoundry.benchmarks.raw-row.v2',
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
      jurisdiction_id: benchmarkCase.metadata?.jurisdiction_id ?? null,
      document_type: benchmarkCase.metadata?.document_type ?? null,
      difficulty: benchmarkCase.metadata?.difficulty ?? null,
      kind: benchmarkCase.metadata?.kind ?? null,
      negative_category: benchmarkCase.metadata?.negative_category ?? null,
      geo_level_2: benchmarkCase.metadata?.geo_level_2 ?? null
    },
    expected: {
      // Suite-declared fields first, so the fixed block below always wins on a
      // name collision. A benchmark adapter declares `publishedExpectedFields`
      // when its gold does not fit the fixed shape -- case-name gold, for
      // instance, is a target CAPTION plus the category, arm, and
      // jurisdiction a per-category table is built from, not a single
      // citation. Without this, re-scoring a published bundle rebuilds every
      // row with no gold.
      ...publishedExpected,
      document_uuid: benchmarkCase.metadata?.document_uuid ?? null,
      canonical_citation: benchmarkCase.metadata?.expected?.canonical_citation ?? null,
      alternates: benchmarkCase.metadata?.expected?.alternates ?? [],
      cl_cluster_id: benchmarkCase.metadata?.expected?.cl_cluster_id ?? null,
      document_title: benchmarkCase.metadata?.document_title ?? null,
      state: benchmarkCase.metadata?.state ?? null,
      source_index: benchmarkCase.metadata?.source_index ?? null,
      kind: benchmarkCase.metadata?.expected?.kind ?? null,
      negative_category: benchmarkCase.metadata?.expected?.negative_category ?? null
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
      server_response_duration_ms: providerResult?.timing?.serverResponseDurationMs ?? null,
      started_at: providerResult?.timing?.startedAt ?? null,
      completed_at: providerResult?.timing?.completedAt ?? null
    },
    token_usage: providerResult?.tokenUsage ?? null,
    score: {
      status: caseScore?.status ?? null,
      hit_rank: caseScore?.hitRank ?? null,
      hit_at: Object.fromEntries(
        cutoffs.map((k) => [
          `hit@${k}`,
          Number.isFinite(caseScore?.hitRank) && caseScore.hitRank <= k
        ])
      ),
      reciprocal_rank: caseScore?.reciprocalRank ?? 0
    }
  };
}

// Backward-compat array form. Prefer streaming via buildRawRow + a writer
// when row counts are large.
export function buildRawRows({
  cases,
  providerResults,
  caseScores,
  publishedExpectedFields = [],
  cutoffs
}) {
  const providerByCase = new Map(providerResults.map((row) => [row.caseId, row]));
  const scoreByCase = new Map(caseScores.map((score) => [score.caseId, score]));
  return cases.map((benchmarkCase) =>
    buildRawRow({
      benchmarkCase,
      providerResult: providerByCase.get(benchmarkCase.caseId) ?? null,
      caseScore: scoreByCase.get(benchmarkCase.caseId) ?? null,
      publishedExpectedFields,
      cutoffs
    })
  );
}

// Reconstructs the (case, provider-result) pair needed by the scorer from a
// single raw row. Pure; safe to call in a streaming verify pipeline. Keep
// field defaults in sync with buildRawRow above.
//
// Populates optional benchmark-specific fields (document_type, difficulty,
// kind, negative_category, geo_level_2) when the raw row has them; older
// bundles missing those fields get null defaults so scorers that ignore
// them can continue to work unchanged.
//
// Deliberately does not read `row.score` at all: a row's score, in either
// shape (`score.hit_at_1`/`hit_at_5`/`hit_at_10`/`hit_at_25` on an older row,
// `score.hit_at['hit@K']` on a current one), is a scorer's prior output, not
// an input. Re-scoring a bundle recomputes it fresh from `results` and
// `expected` below; trusting a stored score here would make verification
// circular. Both row shapes pass through unaffected as a result.
export function reconstructPairFromRawRow(row) {
  const expectedKind = row.expected?.kind ?? 'exact';
  const benchmarkCase = {
    caseId: row.case_id,
    benchmarkId: row.benchmark_id ?? null,
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
      document_type: row.metadata?.document_type ?? null,
      difficulty: row.metadata?.difficulty ?? null,
      kind: row.metadata?.kind ?? null,
      negative_category: row.metadata?.negative_category ?? null,
      geo_level_2: row.metadata?.geo_level_2 ?? null,
      state: row.expected?.state ?? row.request?.state ?? null,
      document_uuid: row.expected?.document_uuid ?? null,
      expected: {
        // Anything the producing adapter declared via `publishedExpectedFields`
        // rides through here. Spread FIRST so the explicitly-mapped fields below
        // remain authoritative.
        ...(row.expected ?? {}),
        kind: expectedKind,
        canonical_citation: row.expected?.canonical_citation ?? null,
        alternates: row.expected?.alternates ?? [],
        cl_cluster_id: row.expected?.cl_cluster_id ?? null,
        document_type: row.metadata?.document_type ?? null,
        difficulty: row.metadata?.difficulty ?? null,
        authority_identifier: row.metadata?.authority_identifier ?? null,
        negative_category: row.expected?.negative_category ?? null
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
    timing: {
      durationMs: row.timing?.duration_ms ?? null,
      serverResponseDurationMs: row.timing?.server_response_duration_ms ?? null
    },
    tokenUsage: row.token_usage ?? null,
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

function resolveScorerId({ manifest, fallback = null }) {
  const id =
    manifest?.scorer?.id ??
    manifest?.run?.scorer?.id ??
    manifest?.scorer_id ??
    fallback;
  if (typeof id !== 'string' || !id) {
    throw new Error(
      `Cannot determine scorer id: manifest is missing scorer.id (and no fallback was provided). ` +
        `Manifests written by executeRun always record it; older bundles may need manual repair.`
    );
  }
  return id;
}

// Streams raw rows through the scorer; never materializes more than one pair
// in memory at a time. Returns the same shape as scorer.score(). The scorer
// id is read from `manifest.scorer.id` when provided (existing bundles set
// this); callers can also pass an explicit `scorerId` to override.
async function scoreRawRowsStream({ rawRowsIterable, manifest = null, scorerId = null }) {
  const resolvedScorerId = scorerId ?? resolveScorerId({ manifest });
  const scorer = getAdapter('scorers', resolvedScorerId);
  async function* pairs() {
    for await (const row of rawRowsIterable) {
      yield reconstructPairFromRawRow(row);
    }
  }
  return scorer.scoreStream({ manifest, pairs: pairs() });
}

// Backward-compat array form. Prefer scoreRawRowsStream for large bundles.
export async function scoreRawRows({ rawRows, manifest = null, scorerId = null }) {
  async function* asIterable() {
    for (const row of rawRows) yield row;
  }
  return scoreRawRowsStream({ rawRowsIterable: asIterable(), manifest, scorerId });
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
      scorer: manifest.scorer ?? null,
      scheduler: manifest.scheduler ?? null
    },
    summary: scores.summary,
    metadata: scores.metadata
  };
}

export async function publishResultBundle({ repoRoot, runDir, outDir, force = false, rawHref = null }) {
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

  // Stream provider-results into (benchmarkCase, providerResult) pairs.
  // `providerPairs` is a generator function, not a generator object -- each
  // call opens a fresh read of provider-results.jsonl, so it can be iterated
  // more than once without materializing the file.
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

  // A benchmark adapter may declare which of its `expected` fields must survive
  // into a published bundle. Resolution is best-effort: a bundle can be
  // published for a benchmark whose adapter is not registered in this process,
  // and that should not be fatal -- it just means no extra fields are carried.
  let publishedExpectedFields = [];
  try {
    const benchmarkAdapter = getAdapter('benchmarks', manifest?.benchmark?.id);
    publishedExpectedFields = benchmarkAdapter?.publishedExpectedFields ?? [];
  } catch {
    publishedExpectedFields = [];
  }

  // Score first, over the full run, so the scorer's configured cutoffs are
  // known: they are reported once, on the finished summary, at
  // `summary.execution.scorer.cutoffs`. Raw rows are then built in a second
  // pass over the same (small, disk-backed) pairs, keyed against the
  // per-case scores this pass already computed. Only one pair is
  // materialized at a time; the second pass re-reads `provider-results.jsonl`
  // from disk rather than holding every pair in memory.
  const scorer = getAdapter('scorers', resolveScorerId({ manifest }));
  const scoreResult = await scorer.scoreStream({ manifest, pairs: providerPairs() });

  const cutoffs = scoreResult.summary?.execution?.scorer?.cutoffs;
  if (!Array.isArray(cutoffs) || cutoffs.length === 0) {
    throw new Error(
      `publishResultBundle: scorer '${resolveScorerId({ manifest })}' did not report ` +
        'summary.execution.scorer.cutoffs -- cannot project score.hit_at into raw rows.'
    );
  }

  const caseScoreByCaseId = new Map(
    (scoreResult.caseScores ?? []).map((caseScore) => [caseScore.caseId, caseScore])
  );
  for await (const { benchmarkCase, providerResult } of providerPairs()) {
    if (!caseScoreByCaseId.has(benchmarkCase.caseId)) {
      throw new Error(
        `publishResultBundle: scorer '${resolveScorerId({ manifest })}' returned no score for ` +
          `case '${benchmarkCase.caseId}' -- refusing to publish a raw row with a guessed score.`
      );
    }
    const rawRow = buildRawRow({
      benchmarkCase,
      providerResult,
      caseScore: caseScoreByCaseId.get(benchmarkCase.caseId),
      publishedExpectedFields,
      cutoffs
    });
    await rawWriter.write(rawRow);
    rowCount += 1;
  }
  await rawWriter.close();

  const gzPath = path.join(resolvedOut, 'raw.jsonl.gz');
  await gzipFile(rawPath, gzPath);
  await unlink(rawPath);
  rawArtifactPath = 'raw.jsonl.gz';
  rawPath = gzPath;

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
        rows: rowCount,
        ...(rawHref ? { href: rawHref } : {})
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
  await writeBundleChecksums({ bundleDir: resolvedOut, rawArtifactPath });
  return { outDir: resolvedOut, manifest: bundleManifest, result };
}

// (Re)writes checksums.txt for a bundle directory from whatever currently
// sits on disk at `raw.jsonl(.gz)`, `result.json`, and `manifest.json`. Any
// caller that rewrites one of those files after publish -- most notably
// adding `artifacts.raw.href` to manifest.json -- must call this afterward:
// a checksums.txt whose manifest.json line does not match the file sitting
// next to it fails `shasum -c` for a reader with no way to tell that from
// real tampering.
export async function writeBundleChecksums({ bundleDir, rawArtifactPath }) {
  const checksums = [
    `${await sha256File(path.join(bundleDir, rawArtifactPath))}  ${rawArtifactPath}`,
    `${await sha256File(path.join(bundleDir, 'result.json'))}  result.json`,
    `${await sha256File(path.join(bundleDir, 'manifest.json'))}  manifest.json`
  ].join('\n');
  await writeText(path.join(bundleDir, 'checksums.txt'), `${checksums}\n`);
}

const HIT_AT_KEY_PATTERN = /^hit@\d+$/;

/**
 * True when `value` is a metric name in the one vocabulary this harness
 * assigns meaning to: a bare `hit@<cutoff>` cutoff name. `assertValidSummary`
 * below and anything outside this module that needs to know whether a
 * `summary.headline.metric` (or a `summary.overall.hit_at` key) is nameable
 * import this rather than keeping a second copy of the pattern, so the
 * schema and any consumer agree by construction on what counts.
 */
export function isHitAtMetric(value) {
  return typeof value === 'string' && HIT_AT_KEY_PATTERN.test(value);
}

function assertHitAtObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!isHitAtMetric(key)) {
      throw new Error(`${label} has key '${key}', which does not match ^hit@\\d+$`);
    }
    if (typeof entry !== 'number') {
      throw new Error(`${label}['${key}'] must be a number`);
    }
  }
}

// Hand-written, synchronous validator for the `summary` shape both scorers
// must produce -- there is no JSON Schema validator dependency in this
// package (zero runtime dependencies), so this enforces by hand exactly what
// `artifact-schemas.json`'s `result.v1.properties.summary` declares. Throws
// on the first violation rather than collecting all of them; message style
// matches `src/core/contracts/index.mjs`'s adapter validators.
export function assertValidSummary(summary) {
  if (summary === null || typeof summary !== 'object') {
    throw new Error('summary must be an object');
  }
  for (const key of ['overall', 'headline']) {
    if (summary[key] === undefined) {
      throw new Error(`summary is missing required key '${key}'`);
    }
  }

  const { overall, headline } = summary;

  if (overall === null || typeof overall !== 'object') {
    throw new Error('summary.overall must be an object');
  }
  for (const key of ['hit_at', 'mrr', 'n']) {
    if (overall[key] === undefined) {
      throw new Error(`summary.overall is missing required key '${key}'`);
    }
  }
  assertHitAtObject(overall.hit_at, 'summary.overall.hit_at');
  if (typeof overall.mrr !== 'number') {
    throw new Error('summary.overall.mrr must be a number');
  }
  if (!Number.isInteger(overall.n)) {
    throw new Error('summary.overall.n must be an integer');
  }

  if (headline === null || typeof headline !== 'object') {
    throw new Error('summary.headline must be an object');
  }
  for (const key of ['metric', 'macro', 'pooled', 'per_category', 'ci95', 'n_categories', 'n_rows']) {
    if (headline[key] === undefined) {
      throw new Error(`summary.headline is missing required key '${key}'`);
    }
  }
  if (!isHitAtMetric(headline.metric)) {
    throw new Error(
      `summary.headline.metric must match ^hit@\\d+$, got ${JSON.stringify(headline.metric)}`
    );
  }
  if (typeof headline.macro !== 'number') {
    throw new Error('summary.headline.macro must be a number');
  }
  if (typeof headline.pooled !== 'number') {
    throw new Error('summary.headline.pooled must be a number');
  }
  if (headline.per_category === null || typeof headline.per_category !== 'object') {
    throw new Error('summary.headline.per_category must be an object');
  }
  if (
    !Array.isArray(headline.ci95) ||
    headline.ci95.length !== 2 ||
    !headline.ci95.every((bound) => typeof bound === 'number')
  ) {
    throw new Error('summary.headline.ci95 must be a two-element array of numbers');
  }
  if (!Number.isInteger(headline.n_categories)) {
    throw new Error('summary.headline.n_categories must be an integer');
  }
  if (!Number.isInteger(headline.n_rows)) {
    throw new Error('summary.headline.n_rows must be an integer');
  }
  return summary;
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

// Resolves the local filesystem path to a bundle's raw evidence, without
// ever materializing its contents in memory: a local `raw.jsonl(.gz)` copy
// is used as-is, and a bundle that only references remote evidence via
// `artifacts.raw.href` is streamed straight to a temp file that the caller
// deletes when done. Callers get a path they can hand to `sha256File` and
// `readRawJsonlStream` unchanged.
async function resolveRawPath({ bundleDir, manifest, allowFetch }) {
  for (const name of ['raw.jsonl.gz', 'raw.jsonl']) {
    const local = path.join(bundleDir, name);
    if (await exists(local)) return { rawPath: local, cleanup: async () => {} };
  }
  const href = manifest?.artifacts?.raw?.href;
  if (!href) {
    throw new Error(
      `${bundleDir}: raw evidence is neither present locally nor referenced by artifacts.raw.href`
    );
  }
  if (!allowFetch) {
    throw new Error(`${bundleDir}: raw evidence is remote and fetching is disabled`);
  }
  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(`${bundleDir}: fetching raw evidence failed — ${response.status} ${href}`);
  }
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'raw-asset-'));
  try {
    const rawName = path.basename(manifest?.artifacts?.raw?.path ?? 'raw.jsonl');
    const tmpPath = path.join(tmpDir, rawName);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
    return {
      rawPath: tmpPath,
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    // The pipeline can fail partway through the download (dropped
    // connection, truncated body) after the directory already exists but
    // before a `cleanup` is ever handed back to a caller. This function
    // created the directory, so it is responsible for removing it on any
    // path that does not return one.
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyResultBundle({
  repoRoot,
  bundleDir,
  verifyInputs = true,
  allowFetch = true
}) {
  const resolvedBundle = path.resolve(repoRoot, bundleDir);
  const manifest = await readJson(path.join(resolvedBundle, 'manifest.json'));
  const { rawPath, cleanup } = await resolveRawPath({ bundleDir: resolvedBundle, manifest, allowFetch });
  try {
    const resultPath = path.join(resolvedBundle, manifest.artifacts?.result?.path ?? 'result.json');
    assertEqual(await sha256File(rawPath), manifest.artifacts.raw.sha256, `${manifest.artifacts.raw.path} digest mismatch`);
    assertEqual(await sha256File(resultPath), manifest.artifacts.result.sha256, 'result.json digest mismatch');

    const result = await readJson(resultPath);
    // Validated before the recompute below so a shape violation is reported
    // as a specific missing/malformed field rather than as an opaque
    // summary mismatch once it is diffed against the freshly recomputed one.
    assertValidSummary(result.summary);

    // Stream raw rows through the scorer; count rows as they go so we can
    // verify against the manifest's row count without materializing the file.
    let rowCount = 0;
    async function* countingRawRows() {
      for await (const row of readRawJsonlStream(rawPath)) {
        rowCount += 1;
        yield row;
      }
    }
    // Prefer the scorer id recorded on the bundled result. Every bundle
    // published by executeRun records `result.run.scorer.id`; a bundle
    // missing that field cannot be verified deterministically.
    const scorerIdForVerify =
      result.run?.scorer?.id ?? result.summary?.execution?.scorer?.id;
    if (typeof scorerIdForVerify !== 'string' || !scorerIdForVerify) {
      throw new Error(
        `verifyResultBundle: bundle ${bundleDir} is missing result.run.scorer.id — ` +
          `cannot determine which scorer to invoke for verification.`
      );
    }
    const recomputed = await scoreRawRowsStream({
      rawRowsIterable: countingRawRows(),
      manifest: result.run
        ? {
            run_id: result.run.run_id,
            benchmark: result.run.benchmark,
            provider: result.run.provider,
            scheduler: result.run.scheduler,
            scorer: result.run.scorer ?? { id: scorerIdForVerify }
          }
        : null,
      scorerId: scorerIdForVerify
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
  } finally {
    await cleanup();
  }
}

// Kept for callers (tests + tooling) that still want to read a whole bundle
// into memory. Prefer readRawJsonlStream + the streaming verifier for large
// bundles.
export { readRawJsonl };
