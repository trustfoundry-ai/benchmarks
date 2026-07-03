import assert from 'node:assert/strict';
import test from 'node:test';

import {
  searchRecallScorerAdapter,
  _internals as scorerInternals
} from '../src/adapters/scorers/search-recall.mjs';

test('scores by expected document UUID or citation and reports hit@k/MRR', async () => {
  const scores = await searchRecallScorerAdapter.score({
    manifest: {
      run_id: 'test-run',
      provider: {
        settings: {
          pricing: {
            model: 'claude-opus-4-8',
            pricing_level: 'Claude API standard pricing',
            source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
            source_accessed_at: '2026-07-02',
            currency: 'USD',
            unit: 'per_1m_tokens',
            input_per_million_tokens: 5,
            output_per_million_tokens: 25
          }
        }
      }
    },
    cases: [
      {
        caseId: 'uuid-case',
        split: 'test',
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
      },
      {
        caseId: 'citation-case',
        split: 'test',
        metadata: {
          datasetIndex: 1,
          datasetName: 'case_questions',
          doc_type: 'case',
          field: 'questions',
          model_type: 'case_question',
          state: 'MI',
          document_uuid: '33333333-3333-3333-3333-333333333333',
          expected: { canonical_citation: '3 Test 3', alternates: [] }
        }
      },
      {
        caseId: 'rank-six-case',
        split: 'test',
        metadata: {
          datasetIndex: 2,
          datasetName: 'case_questions',
          doc_type: 'case',
          field: 'questions',
          model_type: 'case_question',
          state: 'MI',
          document_uuid: '66666666-6666-6666-6666-666666666666',
          expected: { canonical_citation: '6 Test 6', alternates: [] }
        }
      }
    ],
    providerResults: [
      {
        caseId: 'uuid-case',
        status: 'completed',
        finalOutputText: JSON.stringify({
          results: [
            { rank: 1, document_uuid: '22222222-2222-2222-2222-222222222222' },
            { rank: 2, document_uuid: '11111111-1111-1111-1111-111111111111' }
          ]
        }),
        timing: { durationMs: 100, serverResponseDurationMs: 80 },
        tokenUsage: { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 }
      },
      {
        caseId: 'citation-case',
        status: 'completed',
        finalOutputText: JSON.stringify({
          results: [
            { rank: 1, citation: '3 Test 3' }
          ]
        }),
        timing: { durationMs: 100, serverResponseDurationMs: 120 },
        tokenUsage: { inputTokens: 3000, outputTokens: 4000, totalTokens: 7000 }
      },
      {
        caseId: 'rank-six-case',
        status: 'completed',
        finalOutputText: JSON.stringify({
          results: [
            { rank: 1, document_uuid: '11111111-1111-1111-1111-111111111111' },
            { rank: 2, document_uuid: '22222222-2222-2222-2222-222222222222' },
            { rank: 3, document_uuid: '33333333-3333-3333-3333-333333333333' },
            { rank: 4, document_uuid: '44444444-4444-4444-4444-444444444444' },
            { rank: 5, document_uuid: '55555555-5555-5555-5555-555555555555' },
            { rank: 6, document_uuid: '66666666-6666-6666-6666-666666666666' }
          ]
        }),
        timing: { durationMs: 100, serverResponseDurationMs: 160 },
        tokenUsage: {
          raw: {
            input_tokens: 5000,
            output_tokens: 6000,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 8
          }
        }
      }
    ]
  });
  assert.equal(scores.caseScores[0].hitRank, 2);
  assert.equal(scores.caseScores[1].hitRank, 1);
  assert.equal(scores.caseScores[2].hitRank, 6);
  assert.equal(scores.summary.hitAt1, 1 / 3);
  assert.equal(scores.summary.hitAt5, 2 / 3);
  assert.equal(scores.summary.hitAt10, 1);
  assert.equal(scores.summary.hitAt25, 1);
  assert.equal(scores.summary.mrr, 0.5555);
  assert.deepEqual(scores.summary.server_response_duration_ms, {
    n: 3,
    min: 80,
    mean: 120,
    p50: 120,
    p95: 156,
    max: 160
  });
  assert.deepEqual(scores.summary.token_usage, {
    n: 3,
    input_tokens: 9000,
    output_tokens: 12000,
    cache_creation_input_tokens: 7,
    cache_read_input_tokens: 8,
    total_tokens: 21015
  });
  assert.deepEqual(scores.summary.token_cost, {
    currency: 'USD',
    model: 'claude-opus-4-8',
    pricing_level: 'Claude API standard pricing',
    source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    source_accessed_at: '2026-07-02',
    unit: 'per_1m_tokens',
    input_per_million_tokens: 5,
    output_per_million_tokens: 25,
    input_cost: 0.045,
    output_cost: 0.3,
    total_cost: 0.345
  });
  assert.deepEqual(scores.summary.execution.scorer.cutoffs, [1, 5, 10, 25]);
});

test('firstHitRank matches on cl_cluster_id at rank 3 when citation is absent', () => {
  const envelope = {
    results: [
      { rank: 1, cluster_id: 'other-1', citation: null },
      { rank: 2, cluster_id: 'other-2', citation: null },
      { rank: 3, cluster_id: '6751062', citation: null }
    ]
  };
  const expected = { canonical_citation: '13 Mich. 233', alternates: [], cl_cluster_id: '6751062' };
  const rank = scorerInternals.firstHitRank(envelope, expected, null, '6751062');
  assert.equal(rank, 3);
});

test('firstHitRank prefers native ID match order but citation still wins if native misses', () => {
  const envelope = {
    results: [
      { rank: 1, cluster_id: 'nope', citation: '13 Mich. 233' }
    ]
  };
  const expected = { canonical_citation: '13 Mich. 233', alternates: [], cl_cluster_id: '6751062' };
  const rank = scorerInternals.firstHitRank(envelope, expected, null, '6751062');
  assert.equal(rank, 1);
});

test('firstHitRank returns null when no ID and no citation match', () => {
  const envelope = {
    results: [
      { rank: 1, cluster_id: 'nope', citation: 'wrong cite' }
    ]
  };
  const expected = { canonical_citation: '13 Mich. 233', alternates: [], cl_cluster_id: '6751062' };
  const rank = scorerInternals.firstHitRank(envelope, expected, null, '6751062');
  assert.equal(rank, null);
});

test('firstHitRank ignores cl_cluster_id when the field is missing on old-style expected (regression)', () => {
  const envelope = {
    results: [{ rank: 1, cluster_id: '6751062' }]
  };
  const expected = { canonical_citation: '13 Mich. 233', alternates: [] };
  // No cl_cluster_id passed → cluster match path skipped, only citation checked.
  const rank = scorerInternals.firstHitRank(envelope, expected, null, null);
  assert.equal(rank, null);
});

test('scoreCase reads cl_cluster_id from expected and reports it on the case score', async () => {
  const scores = await searchRecallScorerAdapter.score({
    manifest: { run_id: 'cl-test' },
    cases: [
      {
        caseId: 'cl-cluster-only',
        split: 'test',
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
            alternates: [],
            cl_cluster_id: '6751062'
          }
        }
      }
    ],
    providerResults: [
      {
        caseId: 'cl-cluster-only',
        status: 'completed',
        finalOutputText: JSON.stringify({
          results: [
            { rank: 1, cluster_id: 'other-1' },
            { rank: 2, cluster_id: '6751062', citation: null } // native-ID hit
          ]
        }),
        timing: { durationMs: 100 }
      }
    ]
  });
  assert.equal(scores.caseScores[0].hitRank, 2);
  assert.equal(scores.caseScores[0].expectedClusterId, '6751062');
  assert.equal(scores.caseScores[0].hitAt5, true);
});

test('latency summary excludes provider failures and reports failure latency separately', async () => {
  const cases = [
    {
      caseId: 'success-case',
      split: 'test',
      metadata: {
        datasetName: 'case_questions',
        doc_type: 'case',
        field: 'questions',
        model_type: 'case_question',
        state: 'MI',
        expected: { canonical_citation: '1 Test 1', alternates: [] }
      }
    },
    {
      caseId: 'timeout-case',
      split: 'test',
      metadata: {
        datasetName: 'case_questions',
        doc_type: 'case',
        field: 'questions',
        model_type: 'case_question',
        state: 'MI',
        expected: { canonical_citation: '2 Test 2', alternates: [] }
      }
    }
  ];
  const scores = await searchRecallScorerAdapter.score({
    manifest: { run_id: 'latency-test' },
    cases,
    providerResults: [
      {
        caseId: 'success-case',
        status: 'completed',
        finalOutputText: JSON.stringify({ results: [{ rank: 1, citation: '1 Test 1' }] }),
        timing: { durationMs: 123 }
      },
      {
        caseId: 'timeout-case',
        status: 'provider_failure',
        finalOutputText: JSON.stringify({ results: [] }),
        timing: { durationMs: 180000 },
        error: { kind: 'fetch_error', message: 'timeout' }
      }
    ]
  });

  assert.deepEqual(scores.summary.latency_ms, {
    n: 1,
    min: 123,
    mean: 123,
    p50: 123,
    p95: 123,
    max: 123
  });
  assert.deepEqual(scores.summary.provider_failure_latency_ms, {
    n: 1,
    min: 180000,
    mean: 180000,
    p50: 180000,
    p95: 180000,
    max: 180000
  });
});
