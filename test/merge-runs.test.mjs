import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mergeRuns } from '../src/core/runner.mjs';

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function makeCase(index) {
  return {
    caseId: `case-${index}`,
    benchmarkId: 'trustfoundry-legal-search',
    prompt: `question ${index}`,
    split: 'test',
    metadata: {
      datasetName: 'case_questions',
      datasetIndex: index,
      doc_type: 'case',
      field: 'questions',
      model_type: 'case_question',
      state: 'MI',
      expected: {
        kind: 'exact',
        canonical_citation: `${index + 1} Mich. 1`,
        alternates: []
      }
    }
  };
}

function makeProviderResult(index, { status = 'completed', citationHit = true } = {}) {
  const now = new Date().toISOString();
  return {
    caseId: `case-${index}`,
    status,
    rawOutput: { request: { query: `question ${index}` }, httpStatus: 200 },
    finalOutputText: JSON.stringify({
      query: `question ${index}`,
      total_available: 1,
      result_count: 1,
      results: [
        {
          rank: 1,
          citation: citationHit ? `${index + 1} Mich. 1` : 'wrong cite',
          citations: [citationHit ? `${index + 1} Mich. 1` : 'wrong cite']
        }
      ]
    }),
    providerMetadata: { httpStatus: 200 },
    timing: { startedAt: now, completedAt: now, durationMs: 100 },
    error: null
  };
}

function makeManifest({ benchmarkSha, providerSha, scorerSha, caseCount, startedAt, completedAt }) {
  return {
    schema_version: 'trustfoundry.benchmarks.run.v1',
    runId: `run-${startedAt}`,
    run_id: `run-${startedAt}`,
    harness: { name: '@trustfoundry-ai/benchmarks', commit: 'abcdef1' },
    benchmark: {
      id: 'trustfoundry-legal-search',
      version: 'v1',
      configPath: 'configs/benchmarks/example.json',
      configSha256: benchmarkSha
    },
    provider: {
      id: 'trustfoundry-legal-search',
      configPath: 'configs/providers/trustfoundry-legal-search.json',
      configSha256: providerSha
    },
    scorer: {
      id: 'trustfoundry-legal-search',
      configPath: 'configs/scorers/trustfoundry-legal-search.json',
      configSha256: scorerSha
    },
    scheduler: { parallel: 1, caseCount },
    startedAt,
    completedAt
  };
}

async function buildChunkDir(baseDir, indices, { benchmarkSha, providerSha, scorerSha }) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'chunk-'));
  await writeJsonl(
    path.join(dir, 'cases.jsonl'),
    indices.map(makeCase)
  );
  await writeJsonl(
    path.join(dir, 'provider-results.jsonl'),
    indices.map((i) => makeProviderResult(i))
  );
  await writeJson(
    path.join(dir, 'manifest.json'),
    makeManifest({
      benchmarkSha,
      providerSha,
      scorerSha,
      caseCount: indices.length,
      startedAt: `2026-07-01T${String(indices[0]).padStart(2, '0')}:00:00.000Z`,
      completedAt: `2026-07-01T${String(indices[indices.length - 1]).padStart(2, '0')}:59:00.000Z`
    })
  );
  return dir;
}

test('mergeRuns concatenates cases and results, then re-scores', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-runs-'));
  try {
    const shas = { benchmarkSha: 'aaa', providerSha: 'bbb', scorerSha: 'ccc' };
    const chunk1 = await buildChunkDir(tmp, [0, 1, 2], shas);
    const chunk2 = await buildChunkDir(tmp, [3, 4], shas);
    const outDir = path.join(tmp, 'merged');
    const result = await mergeRuns({
      repoRoot: process.cwd(),
      runDirs: [chunk1, chunk2],
      outDir
    });
    assert.equal(result.caseCount, 5);
    assert.equal(result.chunkCount, 2);
    assert.equal(result.scores.summary.total, 5);
    assert.equal(result.scores.summary.scored, 5);
    // hitAt1 is a fraction 0..1, not a count. All 5 cases hit at rank 1 → 1.0.
    assert.equal(result.scores.summary.hitAt1, 1);
    const mergedManifest = JSON.parse(
      await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8')
    );
    assert.equal(mergedManifest.scheduler.caseCount, 5);
    assert.equal(Array.isArray(mergedManifest.chunks), true);
    assert.equal(mergedManifest.chunks.length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('mergeRuns refuses to merge chunks with mismatched benchmark config sha', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-runs-'));
  try {
    const chunk1 = await buildChunkDir(tmp, [0, 1], {
      benchmarkSha: 'aaa',
      providerSha: 'bbb',
      scorerSha: 'ccc'
    });
    const chunk2 = await buildChunkDir(tmp, [2, 3], {
      benchmarkSha: 'DIFFERENT',
      providerSha: 'bbb',
      scorerSha: 'ccc'
    });
    await assert.rejects(
      () =>
        mergeRuns({
          repoRoot: process.cwd(),
          runDirs: [chunk1, chunk2],
          outDir: path.join(tmp, 'merged')
        }),
      /benchmark config sha256/
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('mergeRuns dedupes by caseId with last-wins (retry replaces failure)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-runs-'));
  try {
    const shas = { benchmarkSha: 'aaa', providerSha: 'bbb', scorerSha: 'ccc' };

    // Chunk 1: case-0 failed (quota_exhausted).
    const chunk1 = await fs.mkdtemp(path.join(tmp, 'chunk1-'));
    await writeJsonl(path.join(chunk1, 'cases.jsonl'), [makeCase(0)]);
    await writeJsonl(path.join(chunk1, 'provider-results.jsonl'), [
      {
        ...makeProviderResult(0),
        status: 'provider_failure',
        error: { kind: 'quota_exhausted', message: 'daily cap reached' },
        finalOutputText: JSON.stringify({ query: 'q', results: [], result_count: 0 })
      }
    ]);
    await writeJson(
      path.join(chunk1, 'manifest.json'),
      makeManifest({
        ...shas,
        caseCount: 1,
        startedAt: '2026-07-01T00:00:00.000Z',
        completedAt: '2026-07-01T00:01:00.000Z'
      })
    );

    // Chunk 2: retry of case-0 succeeded with a citation hit.
    const chunk2 = await fs.mkdtemp(path.join(tmp, 'chunk2-'));
    await writeJsonl(path.join(chunk2, 'cases.jsonl'), [makeCase(0)]);
    await writeJsonl(path.join(chunk2, 'provider-results.jsonl'), [
      makeProviderResult(0)
    ]);
    await writeJson(
      path.join(chunk2, 'manifest.json'),
      makeManifest({
        ...shas,
        caseCount: 1,
        startedAt: '2026-07-02T00:00:00.000Z',
        completedAt: '2026-07-02T00:01:00.000Z'
      })
    );

    const outDir = path.join(tmp, 'merged');
    const result = await mergeRuns({
      repoRoot: process.cwd(),
      runDirs: [chunk1, chunk2],
      outDir
    });
    assert.equal(result.caseCount, 1);
    assert.equal(result.scores.summary.providerFailures, 0);
    assert.equal(result.scores.summary.hitAt1, 1); // 1 case, 100% hit rate
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('mergeRuns throws when no run dirs are passed', async () => {
  // outDir points at a path we never actually write to (mergeRuns rejects
  // before touching the filesystem). Kept off `/tmp/` so CodeQL's insecure-
  // temporary-file data flow doesn't chain from this literal.
  await assert.rejects(
    () => mergeRuns({ repoRoot: process.cwd(), runDirs: [], outDir: './does-not-exist-merge-runs-empty' }),
    /at least one input run directory/
  );
});
