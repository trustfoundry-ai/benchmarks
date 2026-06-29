import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import {
  buildRawRows,
  publishResultBundle,
  reconstructFromRawRows,
  verifyResultBundle
} from '../src/core/artifacts.mjs';
import { sha256File, writeJson, writeJsonl, readJson } from '../src/core/fs.mjs';
import { searchRecallScorerAdapter } from '../src/adapters/scorers/search-recall.mjs';

const gzipAsync = promisify(gzip);

async function makeRun(repoRoot, root) {
  const runDir = path.join(root, 'run');
  const cases = [
    {
      caseId: 'case-1',
      benchmarkId: 'public-search-case-questions',
      split: 'test',
      prompt: 'query',
      metadata: {
        datasetIndex: 0,
        datasetName: 'case_questions',
        doc_type: 'case',
        field: 'questions',
        model_type: 'case_question',
        state: 'MI',
        document_uuid: '11111111-1111-1111-1111-111111111111',
        expected: { canonical_citation: '1 Test 1', alternates: [] }
      }
    }
  ];
  const providerResults = [
    {
      caseId: 'case-1',
      status: 'completed',
      rawOutput: {
        request: { query: 'query', model_type: 'case_question', state: 'MI' },
        httpStatus: 200,
        normalizedResults: [
          { rank: 1, document_uuid: '11111111-1111-1111-1111-111111111111' }
        ]
      },
      finalOutputText: JSON.stringify({
        result_count: 1,
        total_available: 1,
        results: [
          { rank: 1, document_uuid: '11111111-1111-1111-1111-111111111111' }
        ]
      }),
      providerMetadata: { httpStatus: 200, totalAvailable: 1 },
      timing: { durationMs: 10 }
    }
  ];
  const manifest = {
    run_id: 'artifact-test',
    benchmark: {
      configPath: 'configs/benchmarks/public-search-case-questions-200.json',
      configSha256: await sha256File(path.join(repoRoot, 'configs/benchmarks/public-search-case-questions-200.json')),
      sourceFiles: [
        {
          path: 'data/public-search-case-questions-5k/case_questions.jsonl',
          sha256: await sha256File(path.join(repoRoot, 'data/public-search-case-questions-5k/case_questions.jsonl'))
        }
      ]
    },
    provider: {
      configPath: 'configs/providers/trustfoundry-public-search-case-question.json',
      configSha256: await sha256File(path.join(repoRoot, 'configs/providers/trustfoundry-public-search-case-question.json'))
    },
    scorer: {
      configPath: 'configs/scorers/search-recall.json',
      configSha256: await sha256File(path.join(repoRoot, 'configs/scorers/search-recall.json'))
    },
    scheduler: { parallel: 1, caseCount: 1 }
  };
  const scores = await searchRecallScorerAdapter.score({ manifest, cases, providerResults });
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  await writeJsonl(path.join(runDir, 'cases.jsonl'), cases);
  await writeJsonl(path.join(runDir, 'provider-results.jsonl'), providerResults);
  await writeJson(path.join(runDir, 'scores.json'), scores);
  return runDir;
}

test('publishes and verifies result bundles, then detects edited summaries', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tf-benchmarks-artifacts-'));
  const runDir = await makeRun(repoRoot, root);
  const outDir = path.join(root, 'bundle');
  await publishResultBundle({ repoRoot, runDir, outDir });
  const verification = await verifyResultBundle({ repoRoot, bundleDir: outDir });
  assert.equal(verification.ok, true);
  assert.equal(verification.rows, 1);

  const resultPath = path.join(outDir, 'result.json');
  const manifestPath = path.join(outDir, 'manifest.json');
  const result = await readJson(resultPath);
  result.summary.hitAt1 = 0;
  await writeJson(resultPath, result);
  const manifest = await readJson(manifestPath);
  manifest.artifacts.result.sha256 = await sha256File(resultPath);
  await writeJson(manifestPath, manifest);
  await assert.rejects(
    () => verifyResultBundle({ repoRoot, bundleDir: outDir }),
    /result summary mismatch/
  );
});

test('aggregate result verification can ignore current input digests', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tf-benchmarks-artifacts-inputs-'));
  const runDir = await makeRun(repoRoot, root);
  const outDir = path.join(root, 'bundle');
  await publishResultBundle({ repoRoot, runDir, outDir });

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.verification_inputs.provider_config.sha256 = 'not-the-current-provider-config';
  await writeJson(manifestPath, manifest);

  await assert.rejects(
    () => verifyResultBundle({ repoRoot, bundleDir: outDir }),
    /provider config digest mismatch/
  );
  const verification = await verifyResultBundle({
    repoRoot,
    bundleDir: outDir,
    verifyInputs: false
  });
  assert.equal(verification.ok, true);
  assert.equal(verification.rows, 1);
});

test('verifies result bundles with gzip-compressed raw rows', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tf-benchmarks-artifacts-gz-'));
  const runDir = await makeRun(repoRoot, root);
  const outDir = path.join(root, 'bundle');
  await publishResultBundle({ repoRoot, runDir, outDir });

  const rawPath = path.join(outDir, 'raw.jsonl');
  const gzPath = path.join(outDir, 'raw.jsonl.gz');
  await writeFile(gzPath, await gzipAsync(await readFile(rawPath)));
  await unlink(rawPath);

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.artifacts.raw.path = 'raw.jsonl.gz';
  manifest.artifacts.raw.sha256 = await sha256File(gzPath);
  await writeJson(manifestPath, manifest);

  const verification = await verifyResultBundle({ repoRoot, bundleDir: outDir });
  assert.equal(verification.ok, true);
  assert.equal(verification.rows, 1);
});

test('raw rows preserve non-case legal search metadata for recomputation', () => {
  const cases = [
    {
      caseId: 'law-1',
      benchmarkId: 'trustfoundry-legal-search',
      split: 'test',
      prompt: 'query',
      metadata: {
        datasetIndex: 0,
        datasetName: 'laws',
        doc_type: 'law',
        field: 'questions',
        model_type: 'law_question',
        datasource_id: 'me-laws',
        authority_identifier: 'mainelegislature.org',
        jurisdiction_id: 'me',
        state: 'ME',
        document_uuid: '22222222-2222-2222-2222-222222222222',
        expected: { canonical_citation: 'Me. Stat. tit. 1, \u00a7 1', alternates: [] }
      }
    }
  ];
  const providerResults = [
    {
      caseId: 'law-1',
      status: 'completed',
      rawOutput: {
        request: { query: 'query', model_type: 'law_question', state: 'ME' },
        normalizedResults: [
          { rank: 1, document_uuid: '22222222-2222-2222-2222-222222222222' }
        ]
      },
      finalOutputText: JSON.stringify({
        result_count: 1,
        results: [
          { rank: 1, document_uuid: '22222222-2222-2222-2222-222222222222' }
        ]
      }),
      timing: { durationMs: 10 }
    }
  ];
  const caseScores = [
    {
      caseId: 'law-1',
      status: 'scored',
      hitRank: 1,
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      hitAt25: true,
      reciprocalRank: 1
    }
  ];
  const rawRows = buildRawRows({ cases, providerResults, caseScores });
  assert.equal(rawRows[0].benchmark_id, 'trustfoundry-legal-search');
  assert.deepEqual(rawRows[0].metadata, {
    doc_type: 'law',
    field: 'questions',
    model_type: 'law_question',
    datasource_id: 'me-laws',
    authority_identifier: 'mainelegislature.org',
    jurisdiction_id: 'me'
  });

  const reconstructed = reconstructFromRawRows(rawRows);
  assert.equal(reconstructed.cases[0].benchmarkId, 'trustfoundry-legal-search');
  assert.equal(reconstructed.cases[0].metadata.doc_type, 'law');
  assert.equal(reconstructed.cases[0].metadata.model_type, 'law_question');
  assert.equal(reconstructed.cases[0].metadata.datasource_id, 'me-laws');
});
