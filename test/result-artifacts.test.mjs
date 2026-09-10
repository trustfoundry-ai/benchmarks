import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import {
  buildRawRows,
  publishResultBundle,
  reconstructFromRawRows,
  verifyResultBundle
} from '../src/core/artifacts.mjs';
import { exists, sha256File, writeJson, writeJsonl, readJson } from '../src/core/fs.mjs';
import { trustfoundryLegalSearchScorerAdapter } from '../src/adapters/scorers/trustfoundry-legal-search.mjs';

const gunzipAsync = promisify(gunzip);

async function makeRun(repoRoot, root) {
  const runDir = path.join(root, 'run');
  const cases = [
    {
      caseId: 'case-1',
      benchmarkId: 'trustfoundry-legal-search',
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
      timing: { durationMs: 10, serverResponseDurationMs: 8 }
    }
  ];
  const manifest = {
    run_id: 'artifact-test',
    benchmark: {
      configPath: 'configs/benchmarks/trustfoundry-legal-search/case-questions-200.json',
      configSha256: await sha256File(path.join(repoRoot, 'configs/benchmarks/trustfoundry-legal-search/case-questions-200.json')),
      sourceFiles: [
        {
          path: 'data/trustfoundry-legal-search/case_questions.jsonl',
          sha256: await sha256File(path.join(repoRoot, 'data/trustfoundry-legal-search/case_questions.jsonl'))
        }
      ]
    },
    provider: {
      configPath: 'configs/providers/trustfoundry-legal-search.json',
      configSha256: await sha256File(path.join(repoRoot, 'configs/providers/trustfoundry-legal-search.json'))
    },
    scorer: {
      id: 'trustfoundry-legal-search',
      configPath: 'configs/scorers/trustfoundry-legal-search.json',
      configSha256: await sha256File(path.join(repoRoot, 'configs/scorers/trustfoundry-legal-search.json'))
    },
    scheduler: { parallel: 1, caseCount: 1 }
  };
  const scores = await trustfoundryLegalSearchScorerAdapter.score({ manifest, cases, providerResults });
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

test('verifies result bundles from a plain (non-gzip) raw.jsonl copy', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tf-benchmarks-artifacts-plain-'));
  const runDir = await makeRun(repoRoot, root);
  const outDir = path.join(root, 'bundle');
  await publishResultBundle({ repoRoot, runDir, outDir });

  const gzPath = path.join(outDir, 'raw.jsonl.gz');
  const rawPath = path.join(outDir, 'raw.jsonl');
  await writeFile(rawPath, await gunzipAsync(await readFile(gzPath)));
  await unlink(gzPath);

  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.artifacts.raw.path = 'raw.jsonl';
  manifest.artifacts.raw.sha256 = await sha256File(rawPath);
  await writeJson(manifestPath, manifest);

  const verification = await verifyResultBundle({ repoRoot, bundleDir: outDir });
  assert.equal(verification.ok, true);
  assert.equal(verification.rows, 1);
});

test('publishResultBundle always writes gzipped raw evidence', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'tf-benchmarks-artifacts-gzip-always-'));
  const runDir = await makeRun(repoRoot, root);
  const outDir = path.join(root, 'bundle');
  await publishResultBundle({ repoRoot, runDir, outDir });

  assert.equal(await exists(path.join(outDir, 'raw.jsonl.gz')), true);
  assert.equal(await exists(path.join(outDir, 'raw.jsonl')), false);
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
      timing: { durationMs: 10, serverResponseDurationMs: 8 },
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
        totalTokens: 307
      }
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
  assert.equal(rawRows[0].timing.server_response_duration_ms, 8);
  assert.deepEqual(rawRows[0].token_usage, {
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 4,
    totalTokens: 307
  });
  assert.deepEqual(rawRows[0].metadata, {
    doc_type: 'law',
    field: 'questions',
    model_type: 'law_question',
    datasource_id: 'me-laws',
    authority_identifier: 'mainelegislature.org',
    jurisdiction_id: 'me',
    document_type: null,
    difficulty: null,
    kind: null,
    negative_category: null,
    geo_level_2: null
  });

  const reconstructed = reconstructFromRawRows(rawRows);
  assert.equal(reconstructed.cases[0].benchmarkId, 'trustfoundry-legal-search');
  assert.equal(reconstructed.cases[0].metadata.doc_type, 'law');
  assert.equal(reconstructed.cases[0].metadata.model_type, 'law_question');
  assert.equal(reconstructed.cases[0].metadata.datasource_id, 'me-laws');
  assert.equal(reconstructed.providerResults[0].timing.serverResponseDurationMs, 8);
  assert.deepEqual(reconstructed.providerResults[0].tokenUsage, {
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 4,
    totalTokens: 307
  });
});

test('raw row round-trip preserves cl_cluster_id when present on the case', () => {
  const cases = [
    {
      caseId: 'cl-case-1',
      benchmarkId: 'trustfoundry-legal-search',
      split: 'test',
      prompt: 'query',
      metadata: {
        datasetIndex: 0,
        datasetName: 'case_questions',
        doc_type: 'case',
        field: 'questions',
        model_type: 'case_question',
        state: 'MI',
        document_uuid: 'e09cb8d7-bbff-1bd1-773c-57517679901e',
        expected: {
          canonical_citation: '13 Mich. 233',
          alternates: ['1865 Mich. LEXIS 19'],
          cl_cluster_id: '6751062'
        }
      }
    }
  ];
  const providerResults = [
    {
      caseId: 'cl-case-1',
      status: 'completed',
      finalOutputText: JSON.stringify({ results: [{ rank: 1, cluster_id: '6751062' }] }),
      timing: { durationMs: 10 }
    }
  ];
  const caseScores = [
    {
      caseId: 'cl-case-1',
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
  assert.equal(rawRows[0].expected.cl_cluster_id, '6751062');
  const reconstructed = reconstructFromRawRows(rawRows);
  assert.equal(reconstructed.cases[0].metadata.expected.cl_cluster_id, '6751062');
});

test('raw row round-trip: old-style rows without cl_cluster_id reconstruct as null (regression)', () => {
  const rawRows = [
    {
      schema_version: 'trustfoundry.benchmarks.raw-row.v1',
      case_id: 'legacy-1',
      benchmark_id: 'trustfoundry-legal-search',
      split: 'test',
      prompt: 'q',
      metadata: { doc_type: 'case', field: 'questions', model_type: 'case_question' },
      // Deliberately no cl_cluster_id on this v1 row (older bundle shape).
      expected: {
        document_uuid: '11111111-1111-1111-1111-111111111111',
        canonical_citation: '1 Test 1',
        alternates: []
      },
      response: { provider_status: 'completed', result_count: 0, results: [] },
      timing: {}
    }
  ];
  const { cases } = reconstructFromRawRows(rawRows);
  assert.equal(cases[0].metadata.expected.cl_cluster_id, null);
});

test('raw row round-trip carries adapter-declared expected fields', () => {
  // The fixed `expected` block is shaped for single-citation gold. A suite whose
  // gold does not fit that shape declares `publishedExpectedFields`, and those
  // must survive publication or a re-score of the bundle rebuilds every row with
  // no gold. That failure is silent -- every metric simply reads 0 -- which is
  // why this is a test rather than a comment.
  const benchmarkCase = {
    caseId: 'c-1',
    prompt: 'Roe v. Wade',
    metadata: {
      expected: {
        kind: 'positive',
        gold_citations: [{ canonical_citation: '410 U.S. 113', alternates: ['93 S. Ct. 705'] }],
        case_name: 'Roe v. Wade',
        name_transform: 'party_misspell',
        tier: 'qualified',
        secret_internal_field: 'must-not-be-published'
      }
    }
  };

  const [row] = buildRawRows({
    cases: [benchmarkCase],
    providerResults: [{ caseId: 'c-1', status: 'completed' }],
    caseScores: [{ caseId: 'c-1', status: 'scored' }],
    publishedExpectedFields: ['gold_citations', 'case_name', 'name_transform', 'tier']
  });

  assert.deepEqual(row.expected.gold_citations, benchmarkCase.metadata.expected.gold_citations);
  assert.equal(row.expected.case_name, 'Roe v. Wade');
  assert.equal(row.expected.name_transform, 'party_misspell');
  assert.equal(row.expected.tier, 'qualified');

  // Undeclared fields are NOT published. The declaration is an allowlist, not a
  // convenience -- `metadata.expected` can hold internal identifiers, and a
  // published bundle is a public artifact.
  assert.equal(row.expected.secret_internal_field, undefined);

  const { cases: restoredCases } = reconstructFromRawRows([row]);
  const restored = restoredCases[0].metadata.expected;
  assert.deepEqual(restored.gold_citations, benchmarkCase.metadata.expected.gold_citations);
  assert.equal(restored.case_name, 'Roe v. Wade');
  assert.equal(restored.name_transform, 'party_misspell');
  assert.equal(restored.tier, 'qualified');
});

test('raw row round-trip: no declaration publishes no extra fields (regression)', () => {
  const [row] = buildRawRows({
    cases: [{ caseId: 'c-2', prompt: 'q', metadata: { expected: { kind: 'positive', gold_citations: [] } } }],
    providerResults: [{ caseId: 'c-2', status: 'completed' }],
    caseScores: [{ caseId: 'c-2', status: 'scored' }]
  });
  assert.equal(row.expected.gold_citations, undefined);
});
