import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mergeRuns } from '../src/core/merge.mjs';

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
    prompt: `q${index}`,
    metadata: {
      expected: { kind: 'exact', canonical_citation: `${index + 1} Mich. 1`, alternates: [] }
    }
  };
}

function makeResult(index, { status = 'completed', citationHit = true, completedAt } = {}) {
  const now = completedAt ?? new Date().toISOString();
  return {
    caseId: `case-${index}`,
    status,
    rawOutput: { httpStatus: 200 },
    finalOutputText: JSON.stringify({
      query: `q${index}`,
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
    timing: { startedAt: now, completedAt: now, durationMs: 100 },
    error: null
  };
}

function makeManifest(startedAt, completedAt, caseCount) {
  return {
    schema_version: 'trustfoundry.benchmarks.run.v1',
    runId: `run-${startedAt}`,
    run_id: `run-${startedAt}`,
    harness: { name: '@trustfoundry-ai/benchmarks', commit: 'abcdef1' },
    benchmark: { id: 'trustfoundry-legal-search', version: 'v1', configPath: 'x.json', configSha256: 'aaa' },
    provider: { id: 'trustfoundry-public-search', configPath: 'y.json', configSha256: 'bbb' },
    scorer: { id: 'search-recall', configPath: 'z.json', configSha256: 'ccc' },
    scheduler: { parallel: 1, caseCount },
    startedAt,
    completedAt
  };
}

async function buildChunk(baseDir, results, startedAt, completedAt) {
  const dir = await fs.mkdtemp(path.join(baseDir, 'chunk-'));
  await writeJsonl(path.join(dir, 'cases.jsonl'), results.map((r) => makeCase(Number(r.caseId.split('-')[1]))));
  await writeJsonl(path.join(dir, 'provider-results.jsonl'), results);
  await writeJson(path.join(dir, 'manifest.json'), makeManifest(startedAt, completedAt, results.length));
  return dir;
}

test("prefer='latest' keeps completed retry when earlier chunk failed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-prefer-'));
  try {
    const chunk1 = await buildChunk(
      tmp,
      [makeResult(0, { status: 'provider_failure', completedAt: '2026-07-01T00:00:00.000Z' })],
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:01:00.000Z'
    );
    const chunk2 = await buildChunk(
      tmp,
      [makeResult(0, { completedAt: '2026-07-02T00:00:00.000Z' })],
      '2026-07-02T00:00:00.000Z',
      '2026-07-02T00:01:00.000Z'
    );
    const result = await mergeRuns({
      repoRoot: process.cwd(),
      runDirs: [chunk1, chunk2],
      outDir: path.join(tmp, 'merged'),
      prefer: 'latest'
    });
    assert.equal(result.scores.summary.providerFailures, 0);
    assert.equal(result.scores.summary.hitAt1, 1);
    const mergeReport = JSON.parse(
      await fs.readFile(path.join(result.outDir, 'merge-report.json'), 'utf8')
    );
    assert.equal(mergeReport.prefer, 'latest');
    assert.equal(mergeReport.conflicts.length, 1);
    assert.equal(mergeReport.conflicts[0].caseId, 'case-0');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("prefer='first' keeps chunk1 result even when chunk2 has one", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-prefer-'));
  try {
    const chunk1 = await buildChunk(
      tmp,
      [makeResult(0, { citationHit: false })],
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:01:00.000Z'
    );
    const chunk2 = await buildChunk(
      tmp,
      [makeResult(0, { citationHit: true })],
      '2026-07-02T00:00:00.000Z',
      '2026-07-02T00:01:00.000Z'
    );
    const result = await mergeRuns({
      repoRoot: process.cwd(),
      runDirs: [chunk1, chunk2],
      outDir: path.join(tmp, 'merged'),
      prefer: 'first'
    });
    // Chunk 1 wins → citationHit=false → hitAt1 = 0.
    assert.equal(result.scores.summary.hitAt1, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('merge writes merge-report.json with conflicts, prefer, and input runs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-report-'));
  try {
    const chunk1 = await buildChunk(
      tmp,
      [makeResult(0)],
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:01:00.000Z'
    );
    const chunk2 = await buildChunk(
      tmp,
      [makeResult(1)],
      '2026-07-02T00:00:00.000Z',
      '2026-07-02T00:01:00.000Z'
    );
    const result = await mergeRuns({
      repoRoot: process.cwd(),
      runDirs: [chunk1, chunk2],
      outDir: path.join(tmp, 'merged')
    });
    const mergeReport = JSON.parse(
      await fs.readFile(path.join(result.outDir, 'merge-report.json'), 'utf8')
    );
    assert.equal(mergeReport.prefer, 'explicit-run-order');
    assert.equal(mergeReport.cases, 2);
    assert.equal(mergeReport.providerResults, 2);
    assert.deepEqual(mergeReport.conflicts, []);
    assert.equal(mergeReport.inputRuns.length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
