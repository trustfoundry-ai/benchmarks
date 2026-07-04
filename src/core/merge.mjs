/**
 * Merge N chunk runs into one canonical run directory.
 *
 * Refuses to merge chunks whose benchmark / provider / scorer config
 * sha256 disagree — that would silently mix runs with different inputs.
 * Chunks may share caseIds (e.g. a retry-failed chunk covering the same
 * cases as an earlier chunk); the `prefer` policy decides which result
 * wins:
 *
 *   - 'explicit-run-order' (default) — the chunk listed last in
 *     `runDirs` wins. Matches the historical merge behavior.
 *   - 'latest' — completed status wins, then latest `timing.completedAt`,
 *     then run order. Useful when you don't want a failed retry to
 *     overwrite a completed earlier result.
 *   - 'completed' — completed status wins, then run order.
 *   - 'first' — the chunk listed first in `runDirs` wins.
 *
 * Every merge writes `merge-report.json` with the input runs, the policy
 * used, and any conflicts observed.
 */
import path from 'node:path';

import {
  exists,
  readJson,
  readJsonl,
  readJsonlStream,
  relativePath,
  writeJson,
  writeJsonl
} from './fs.mjs';
import { computeFingerprints } from './manifest.mjs';
import { getAdapter } from './registry.mjs';

const DEFAULT_SCORER_ID = 'search-recall';

function nowCompact() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function resultRank(result, policy, sourceIndex) {
  if (policy === 'first') return -sourceIndex;
  if (policy === 'explicit-run-order') return sourceIndex;
  const completedBonus = result.status === 'completed' ? 1_000_000 : 0;
  const timestamp =
    Date.parse(result.timing?.completedAt ?? result.completedAt ?? '') || 0;
  return policy === 'completed'
    ? completedBonus + sourceIndex
    : completedBonus + timestamp + sourceIndex;
}

function chooseWinner(existing, candidate, policy) {
  const existingRank = resultRank(existing.result, policy, existing.sourceIndex);
  const candidateRank = resultRank(candidate.result, policy, candidate.sourceIndex);
  return candidateRank >= existingRank ? candidate : existing;
}

async function scoreFromDisk({ scorerAdapter, manifest, cases, providerResultsPath }) {
  const casesById = new Map(
    cases.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase])
  );
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

export async function mergeRuns({
  repoRoot,
  runDirs,
  outDir,
  prefer = 'explicit-run-order',
  force = false
}) {
  if (!Array.isArray(runDirs) || runDirs.length === 0) {
    throw new Error('mergeRuns requires at least one input run directory');
  }
  const resolvedOut = path.resolve(repoRoot, outDir);
  if ((await exists(resolvedOut)) && !force) {
    throw new Error(
      `Output directory already exists: ${resolvedOut}. Use --force to overwrite.`
    );
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
  const conflicts = [];
  for (const [sourceIndex, chunk] of chunks.entries()) {
    const chunkCases = await readJsonl(path.join(chunk.runDir, 'cases.jsonl'));
    for (const benchmarkCase of chunkCases) {
      if (!casesById.has(benchmarkCase.caseId)) casesById.set(benchmarkCase.caseId, benchmarkCase);
    }
    const chunkResults = await readJsonl(path.join(chunk.runDir, 'provider-results.jsonl'));
    for (const providerResult of chunkResults) {
      const candidate = { result: providerResult, sourceIndex };
      const existing = resultsById.get(providerResult.caseId);
      if (!existing) {
        resultsById.set(providerResult.caseId, candidate);
        continue;
      }
      const winner = chooseWinner(existing, candidate, prefer);
      conflicts.push({
        caseId: providerResult.caseId,
        prefer,
        existingSourceIndex: existing.sourceIndex,
        candidateSourceIndex: sourceIndex,
        keptSourceIndex: winner.sourceIndex
      });
      resultsById.set(providerResult.caseId, winner);
    }
    const inventoryPath = path.join(chunk.runDir, 'inventory.json');
    if (await exists(inventoryPath)) {
      const inventory = await readJson(inventoryPath);
      if (Array.isArray(inventory.records)) inventoryRecords.push(...inventory.records);
    }
  }

  const mergedCases = [...casesById.values()];
  const mergedResults = [...resultsById.values()].map((entry) => entry.result);
  let providerFailures = 0;
  for (const providerResult of mergedResults) {
    if (providerResult.status !== 'completed') providerFailures += 1;
  }

  const runId = `merge-${nowCompact()}`;
  const mergedManifestBase = {
    ...first,
    runId,
    run_id: runId,
    runKind: 'merged',
    startedAt: chunks.reduce(
      (min, chunk) => (min && min < chunk.manifest.startedAt ? min : chunk.manifest.startedAt),
      null
    ),
    completedAt: chunks.reduce(
      (max, chunk) =>
        max && max > (chunk.manifest.completedAt ?? '') ? max : chunk.manifest.completedAt,
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
  const mergedManifest = {
    ...mergedManifestBase,
    fingerprints: computeFingerprints(mergedManifestBase)
  };

  await writeJsonl(path.join(resolvedOut, 'cases.jsonl'), mergedCases);
  const providerResultsPath = path.join(resolvedOut, 'provider-results.jsonl');
  await writeJsonl(providerResultsPath, mergedResults);
  await writeJson(path.join(resolvedOut, 'manifest.json'), mergedManifest);
  await writeJson(path.join(resolvedOut, 'merge-report.json'), {
    generatedAt: new Date().toISOString(),
    prefer,
    inputRuns: mergedManifest.chunks,
    cases: mergedCases.length,
    providerResults: mergedResults.length,
    conflicts
  });
  if (inventoryRecords.length) {
    await writeJson(path.join(resolvedOut, 'inventory.json'), {
      benchmark: first.benchmark?.id ?? null,
      records: inventoryRecords,
      summary: { total: mergedCases.length, selected: mergedCases.length, available_skipped: 0 }
    });
  }

  const scorerAdapter = getAdapter('scorers', mergedManifest.scorer?.id ?? DEFAULT_SCORER_ID);
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
