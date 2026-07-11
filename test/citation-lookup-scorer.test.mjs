import assert from 'node:assert/strict';
import test from 'node:test';

import { citationLookupScorerAdapter, _internals } from '../src/adapters/scorers/citation-lookup.mjs';

function mkCase({ caseId = 'c1', kind = 'positive', docType = 'case_law', difficulty = 'bluebook', expected = {}, negativeCategory = null, state = 'FED' } = {}) {
  return {
    caseId,
    metadata: {
      doc_type: docType,
      difficulty,
      datasource_id: 'courtlistener',
      state,
      negative_category: negativeCategory,
      model_type: 'citation_search',
      expected: { kind, document_type: docType, ...expected }
    }
  };
}

function mkProviderResult({ caseId = 'c1', envelope = { results: [] }, status = 'completed', durationMs = 100 } = {}) {
  return {
    caseId,
    status,
    finalOutputText: JSON.stringify(envelope),
    timing: { durationMs }
  };
}

async function scoreOne(benchmarkCase, providerResult, config = {}) {
  return citationLookupScorerAdapter.score({
    manifest: null,
    cases: [benchmarkCase],
    providerResults: [providerResult],
    config
  });
}

test('positive TF row: document_uuid match at rank 1 → Recall@1 = 1', async () => {
  const bc = mkCase({
    expected: {
      canonical_citation: '410 U.S. 113',
      alternates: [],
      document_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      cl_cluster_id: '108713'
    }
  });
  const pr = mkProviderResult({
    envelope: {
      results: [{ rank: 1, document_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', citation: '410 U.S. 113' }]
    }
  });
  const out = await scoreOne(bc, pr);
  assert.equal(out.summary.overallScore, 1);
  assert.equal(out.summary.hitAt1, 1);
  assert.equal(out.caseScores[0].hitRank, 1);
});

test('positive TF row: citation-string match when document_uuid absent from result', async () => {
  const bc = mkCase({
    expected: {
      canonical_citation: '410 U.S. 113',
      alternates: [],
      document_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    }
  });
  const pr = mkProviderResult({
    envelope: {
      results: [
        { rank: 1, document_uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', citation: 'other' },
        { rank: 2, document_uuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc', citation: '410 U.S. 113' }
      ]
    }
  });
  const out = await scoreOne(bc, pr);
  assert.equal(out.caseScores[0].hitRank, 2);
  assert.equal(out.summary.hitAt1, 0);
  assert.equal(out.summary.hitAt5, 1);
});

test('positive CL row: cluster_id match at rank 1', async () => {
  const bc = mkCase({
    expected: { canonical_citation: '410 U.S. 113', alternates: [], cl_cluster_id: '108713' }
  });
  const pr = mkProviderResult({
    envelope: {
      results: [{ rank: 1, cluster_id: '108713', case_name: 'Roe v. Wade' }]
    }
  });
  const out = await scoreOne(bc, pr);
  assert.equal(out.caseScores[0].hitRank, 1);
  assert.equal(out.summary.overallScore, 1);
});

test('positive CL row: cluster_id at rank 3 → Recall@5 = 1 but Recall@1 = 0', async () => {
  const bc = mkCase({
    expected: { canonical_citation: '5 F.3d 100', alternates: [], cl_cluster_id: '42' }
  });
  const pr = mkProviderResult({
    envelope: {
      results: [
        { rank: 1, cluster_id: '10' },
        { rank: 2, cluster_id: '20' },
        { rank: 3, cluster_id: '42' }
      ]
    }
  });
  const out = await scoreOne(bc, pr);
  assert.equal(out.caseScores[0].hitRank, 3);
  assert.equal(out.summary.hitAt1, 0);
  assert.equal(out.summary.hitAt5, 1);
  assert.equal(out.summary.mrr, 0.3333);
});

test('ambiguous CL (status 300) with correct cluster present → counted correct + ambiguousRate captures it', async () => {
  const bc = mkCase({
    expected: { canonical_citation: '5 F.3d 100', alternates: [], cl_cluster_id: '2' }
  });
  const pr = mkProviderResult({
    envelope: {
      status: 300,
      provider_ambiguous: true,
      results: [
        { rank: 1, cluster_id: '1' },
        { rank: 2, cluster_id: '2' }
      ]
    }
  });
  const out = await scoreOne(bc, pr);
  assert.equal(out.caseScores[0].providerAmbiguous, true);
  assert.equal(out.summary.ambiguousRate, 1);
  assert.equal(out.caseScores[0].hitRank, 2);
  assert.equal(out.summary.hitAt5, 1);
});

test('negative row + empty response → correct; ambiguousRate not affected by negatives', async () => {
  const bc = mkCase({
    kind: 'negative',
    docType: null,
    difficulty: null,
    negativeCategory: 'phone',
    expected: { canonical_citation: null, alternates: [] }
  });
  const pr = mkProviderResult({ envelope: { results: [] } });
  const out = await scoreOne(bc, pr);
  assert.equal(out.caseScores[0].score, 1);
  assert.equal(out.caseScores[0].falsePositive, false);
  assert.equal(out.summary.negatives_overall.fp_rate, 0);
  assert.equal(out.summary.negatives_overall.correct_empty, 1);
});

test('negative row + non-empty response → false positive', async () => {
  const bc = mkCase({
    kind: 'negative',
    docType: null,
    difficulty: null,
    negativeCategory: 'phone',
    expected: { canonical_citation: null, alternates: [] }
  });
  const pr = mkProviderResult({
    envelope: { results: [{ rank: 1, cluster_id: '99', citation: 'not a real match' }] }
  });
  const out = await scoreOne(bc, pr);
  assert.equal(out.caseScores[0].score, 0);
  assert.equal(out.caseScores[0].falsePositive, true);
  assert.equal(out.summary.negatives_overall.fp_rate, 1);
});

test('stratification: mix of bluebook/noisy splits byDifficulty correctly', async () => {
  const cases = [
    mkCase({ caseId: 'c1', difficulty: 'bluebook', expected: { canonical_citation: 'a', document_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }),
    mkCase({ caseId: 'c2', difficulty: 'bluebook', expected: { canonical_citation: 'b', document_uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } }),
    mkCase({ caseId: 'c3', difficulty: 'noisy', expected: { canonical_citation: 'c', document_uuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc' } }),
    mkCase({ caseId: 'c4', difficulty: 'noisy', expected: { canonical_citation: 'd', document_uuid: 'dddddddd-dddd-dddd-dddd-dddddddddddd' } })
  ];
  const providerResults = [
    mkProviderResult({ caseId: 'c1', envelope: { results: [{ rank: 1, document_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] } }),
    mkProviderResult({ caseId: 'c2', envelope: { results: [] } }),
    mkProviderResult({ caseId: 'c3', envelope: { results: [{ rank: 1, document_uuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }] } }),
    mkProviderResult({ caseId: 'c4', envelope: { results: [] } })
  ];
  const out = await citationLookupScorerAdapter.score({ manifest: null, cases, providerResults });
  assert.equal(out.summary.byDifficulty.bluebook.hit_at['hit@1'], 0.5);
  assert.equal(out.summary.byDifficulty.noisy.hit_at['hit@1'], 0.5);
});

test('provider_failure short-circuits with score 0 and no result count', async () => {
  const bc = mkCase({
    expected: { canonical_citation: 'x', alternates: [], document_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
  });
  const pr = {
    caseId: 'c1',
    status: 'provider_failure',
    finalOutputText: JSON.stringify({ results: [] }),
    timing: { durationMs: 500 },
    error: { kind: 'rate_limited', message: 'HTTP 429' }
  };
  const out = await scoreOne(bc, pr);
  assert.equal(out.caseScores[0].status, 'provider_failure');
  assert.equal(out.caseScores[0].score, 0);
  assert.equal(out.summary.providerFailures, 1);
});

test('validateConfig rejects mismatched cutoffs', () => {
  assert.throws(() => {
    citationLookupScorerAdapter.validateConfig({ scorerConfig: { cutoffs: [1, 3] } });
  }, /cutoffs/);
});

test('validateConfig rejects mismatched headline_cutoff', () => {
  assert.throws(() => {
    citationLookupScorerAdapter.validateConfig({ scorerConfig: { headline_cutoff: 5 } });
  }, /headline_cutoff/);
});

test('_internals.firstHitRank prefers document_uuid over citation string', () => {
  const rank = _internals.firstHitRank(
    { results: [{ rank: 1, citation: 'nomatch' }, { rank: 2, document_uuid: 'target-uuid' }] },
    { document_uuid: 'target-uuid', canonical_citation: 'z' }
  );
  assert.equal(rank, 2);
});
