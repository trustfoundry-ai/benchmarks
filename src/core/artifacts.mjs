import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gunzip } from 'node:zlib';

import {
  canonicalStringify,
  exists,
  readJson,
  readJsonl,
  relativePath,
  sha256File,
  writeJson,
  writeJsonl,
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

async function gzipFile(source, target) {
  await pipeline(
    createReadStream(source),
    createGzip({ level: 9 }),
    createWriteStream(target)
  );
}

function byCaseId(rows) {
  return new Map(rows.map((row) => [row.caseId, row]));
}

function normalizedResults(providerResult) {
  const parsed = safeParseJson(providerResult.finalOutputText);
  return Array.isArray(parsed?.results)
    ? parsed.results
    : Array.isArray(providerResult.rawOutput?.normalizedResults)
      ? providerResult.rawOutput.normalizedResults
      : [];
}

export function buildRawRows({ cases, providerResults, caseScores }) {
  const providerByCase = byCaseId(providerResults);
  const scoreByCase = new Map(caseScores.map((score) => [score.caseId, score]));
  return cases.map((benchmarkCase) => {
    const providerResult = providerByCase.get(benchmarkCase.caseId) ?? null;
    const caseScore = scoreByCase.get(benchmarkCase.caseId) ?? null;
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
        http_status: providerResult?.providerMetadata?.httpStatus ?? providerResult?.rawOutput?.httpStatus ?? null,
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
  });
}

export function reconstructFromRawRows(rawRows) {
  const cases = rawRows.map((row) => ({
    caseId: row.case_id,
    benchmarkId: row.benchmark_id ?? 'public-search-case-questions',
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
  }));
  const providerResults = rawRows.map((row) => ({
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
      durationMs: row.timing?.duration_ms ?? null
    },
    error: row.response?.error ?? null
  }));
  return { cases, providerResults };
}

export async function scoreRawRows({ rawRows, manifest = null }) {
  const { cases, providerResults } = reconstructFromRawRows(rawRows);
  const scorer = getAdapter('scorers', 'search-recall');
  return scorer.score({ manifest, cases, providerResults });
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
  const cases = await readJsonl(path.join(resolvedRun, 'cases.jsonl'));
  const providerResults = await readJsonl(path.join(resolvedRun, 'provider-results.jsonl'));
  let scores;
  if (await exists(path.join(resolvedRun, 'scores.json'))) {
    scores = await readJson(path.join(resolvedRun, 'scores.json'));
  } else {
    scores = await getAdapter('scorers', 'search-recall').score({ manifest, cases, providerResults });
  }
  const rawRows = buildRawRows({ cases, providerResults, caseScores: scores.caseScores });
  const recomputed = await scoreRawRows({ rawRows, manifest });
  const result = resultEnvelope({ manifest, scores: recomputed });

  let rawArtifactPath = 'raw.jsonl';
  let rawPath = path.join(resolvedOut, rawArtifactPath);
  const resultPath = path.join(resolvedOut, 'result.json');
  await writeJsonl(rawPath, rawRows);
  if ((await stat(rawPath)).size > LARGE_RAW_GZIP_THRESHOLD_BYTES) {
    const gzPath = path.join(resolvedOut, 'raw.jsonl.gz');
    await gzipFile(rawPath, gzPath);
    await unlink(rawPath);
    rawArtifactPath = 'raw.jsonl.gz';
    rawPath = gzPath;
  }
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
        rows: rawRows.length
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

  const rawRows = await readRawJsonl(rawPath);
  assertEqual(rawRows.length, manifest.artifacts.raw.rows, 'raw row count mismatch');
  const result = await readJson(resultPath);
  const recomputed = await scoreRawRows({
    rawRows,
    manifest: result.run
      ? {
          run_id: result.run.run_id,
          benchmark: result.run.benchmark,
          provider: result.run.provider,
          scheduler: result.run.scheduler
        }
      : null
  });
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
    rows: rawRows.length,
    summary: result.summary
  };
}
