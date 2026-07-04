import assert from 'node:assert/strict';
import test from 'node:test';

import {
  citationLookupScorerAdapter,
  _internals,
  SUPPORTED_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF
} from '../src/adapters/scorers/citation-lookup.mjs';

function positiveCase({
  caseId = 'case-1',
  document_uuid = '00000000-0000-4000-8000-000000000001',
  canonical_citation = '410 U.S. 113',
  difficulty = 'clean',
  document_type = 'case_law',
  authority_identifier = 'scotus',
  datasource_id = 'sample-cases',
  cl_cluster_id = null
} = {}) {
  return {
    caseId,
    benchmarkId: 'citation-lookup',
    prompt: canonical_citation,
    metadata: {
      expected: {
        alternates: [],
        authority_identifier,
        canonical_citation,
        cl_cluster_id,
        datasource_id,
        difficulty,
        document_type,
        document_uuid,
        geo_level_1: 'us',
        geo_level_2: '',
        kind: 'positive'
      },
      document_type,
      difficulty,
      authority_identifier,
      datasource_id,
      geo_level_2: 'FED',
      kind: 'positive',
      cl_cluster_id,
      datasetName: 'citation-lookup-cases'
    }
  };
}

function negativeCase({ caseId = 'neg-1', negative_category = 'date_long' } = {}) {
  return {
    caseId,
    benchmarkId: 'citation-lookup',
    prompt: 'October 4, 2019',
    metadata: {
      expected: {
        alternates: [],
        canonical_citation: null,
        document_type: null,
        kind: 'negative',
        negative_category
      },
      document_type: null,
      difficulty: null,
      authority_identifier: null,
      datasource_id: null,
      geo_level_2: 'FED',
      kind: 'negative',
      negative_category,
      datasetName: 'citation-lookup-negatives'
    }
  };
}

function envelope(results) {
  return { results };
}

function providerResult(caseId, env, { durationMs = 100, status = 'completed' } = {}) {
  return {
    caseId,
    status,
    finalOutputText: JSON.stringify(env),
    timing: { durationMs }
  };
}

async function scoreOne(benchmarkCase, env, resultOverrides = {}) {
  const providerResults = [providerResult(benchmarkCase.caseId, env, resultOverrides)];
  return citationLookupScorerAdapter.score({
    manifest: null,
    cases: [benchmarkCase],
    providerResults
  });
}

test('citation match at rank 1 → hit@1 = 1, MRR = 1, matchedBy=citation', async () => {
  const c = positiveCase();
  const scored = await scoreOne(c, envelope([{ citation: '410 U.S. 113', rank: 1 }]));
  const [only] = scored.caseScores;
  assert.equal(only.status, 'scored');
  assert.equal(only.hitRank, 1);
  assert.equal(only.matchedBy, 'citation');
  assert.equal(only.hitAt1, true);
  assert.equal(only.hitAt5, true);
  assert.equal(only.reciprocalRank, 1);
  assert.equal(scored.summary.headline.hit_at_1, 1);
  assert.equal(scored.summary.headline.ambiguous_match_rate, 0);
  assert.equal(scored.summary.headline.mrr, 1);
  assert.equal(scored.summary.headline.cluster_id_fallback_rate, null);
});

test('citation match at rank 3 → hit@1=0, hit@5=1, MRR=1/3, ambiguous_match_rate contributes', async () => {
  const c = positiveCase();
  const scored = await scoreOne(
    c,
    envelope([
      { citation: '999 U.S. 999', rank: 1 },
      { citation: '888 U.S. 888', rank: 2 },
      { citation: '410 U.S. 113', rank: 3 }
    ])
  );
  const [only] = scored.caseScores;
  assert.equal(only.hitRank, 3);
  assert.equal(only.matchedBy, 'citation');
  assert.equal(only.hitAt1, false);
  assert.equal(only.hitAt5, true);
  assert.equal(only.reciprocalRank, 1 / 3);
  assert.equal(scored.summary.headline.hit_at_1, 0);
  assert.equal(scored.summary.headline.hit_at_5, 1);
  assert.equal(scored.summary.headline.ambiguous_match_rate, 1);
});

test('document_uuid alone (no matching citation) is NOT a hit', async () => {
  const c = positiveCase();
  const scored = await scoreOne(
    c,
    envelope([{ document_uuid: c.metadata.expected.document_uuid, citation: '999 U.S. 999', rank: 1 }])
  );
  const [only] = scored.caseScores;
  assert.equal(only.hitRank, null);
  assert.equal(only.hitAt1, false);
  assert.equal(only.matchedBy, null);
});

test('generic cluster_id fallback — citation did not match but cluster_id did', async () => {
  const c = positiveCase({ cl_cluster_id: '108713' });
  const scored = await scoreOne(
    c,
    envelope([
      { rank: 1, cluster_id: '1', citation: '999 U.S. 999' },
      { rank: 2, cluster_id: '108713', citation: '410 U. S. 113 (Roe)' }
    ])
  );
  const [only] = scored.caseScores;
  assert.equal(only.hitRank, 2);
  assert.equal(only.matchedBy, 'cluster_id');
  assert.equal(scored.summary.headline.cluster_id_fallback_rate, 1);
});

test('citation matches earlier than cluster_id — citation wins the rank', async () => {
  const c = positiveCase({ cl_cluster_id: '108713' });
  const scored = await scoreOne(
    c,
    envelope([
      { rank: 1, cluster_id: '999', citation: '410 U.S. 113' },
      { rank: 2, cluster_id: '108713', citation: 'ambiguous format' }
    ])
  );
  const [only] = scored.caseScores;
  assert.equal(only.hitRank, 1);
  assert.equal(only.matchedBy, 'citation');
});

test('neither citation nor cluster_id matches → scored incorrect', async () => {
  const c = positiveCase({ cl_cluster_id: '108713' });
  const scored = await scoreOne(
    c,
    envelope([{ rank: 1, cluster_id: '999', citation: '999 U.S. 999' }])
  );
  const [only] = scored.caseScores;
  assert.equal(only.hitRank, null);
  assert.equal(only.matchedBy, null);
  assert.equal(only.hitAt1, false);
  assert.equal(only.hitAt5, false);
});

test('cl_cluster_id null on the case (unresolved row) — still scoreable via citation', async () => {
  const c = positiveCase({ cl_cluster_id: null });
  const scored = await scoreOne(
    c,
    envelope([{ rank: 1, cluster_id: '108713', citation: '410 U.S. 113' }])
  );
  const [only] = scored.caseScores;
  assert.equal(only.validGold, true);
  assert.equal(only.hitRank, 1);
  assert.equal(only.matchedBy, 'citation');
});

test('cluster_id_fallback_rate is null when no positives have cl_cluster_id set', async () => {
  const c = positiveCase({ cl_cluster_id: null });
  const scored = await scoreOne(c, envelope([{ citation: '410 U.S. 113', rank: 1 }]));
  assert.equal(scored.summary.headline.cluster_id_fallback_rate, null);
});

test('negative row: empty envelope → correct, no false positive', async () => {
  const c = negativeCase();
  const scored = await scoreOne(c, envelope([]));
  const [only] = scored.caseScores;
  assert.equal(only.negative, true);
  assert.equal(only.negativeCorrect, true);
  assert.equal(only.falsePositive, false);
  assert.equal(scored.summary.negatives.fp_rate, 0);
  assert.equal(scored.summary.headline.fp_rate, 0);
});

test('negative row: non-empty envelope → false positive, bumps fp_rate', async () => {
  const c = negativeCase();
  const scored = await scoreOne(c, envelope([{ rank: 1, citation: 'anything' }]));
  const [only] = scored.caseScores;
  assert.equal(only.negativeCorrect, false);
  assert.equal(only.falsePositive, true);
  assert.equal(scored.summary.headline.fp_rate, 1);
});

test('negatives excluded from positives denominator; fp_rate reflects negatives-only', async () => {
  const hit = positiveCase({ caseId: 'p-hit' });
  const negOk = negativeCase({ caseId: 'neg-ok' });
  const negFp = negativeCase({ caseId: 'neg-fp' });
  const providerResults = [
    providerResult(hit.caseId, envelope([{ citation: hit.metadata.expected.canonical_citation, rank: 1 }])),
    providerResult(negOk.caseId, envelope([])),
    providerResult(negFp.caseId, envelope([{ citation: 'anything', rank: 1 }]))
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases: [hit, negOk, negFp],
    providerResults
  });
  assert.equal(scored.summary.headline.hit_at_1, 1);
  assert.equal(scored.summary.positives.n, 1);
  assert.equal(scored.summary.headline.fp_rate, 0.5);
  assert.equal(scored.summary.negatives.n, 2);
});

test('byDifficulty stratifies on difficulty tier', async () => {
  const clean = positiveCase({ caseId: 'clean-1', difficulty: 'clean' });
  const sloppy = positiveCase({ caseId: 'sloppy-1', difficulty: 'sloppy' });
  const providerResults = [
    providerResult(clean.caseId, envelope([{ citation: clean.metadata.expected.canonical_citation, rank: 1 }])),
    providerResult(sloppy.caseId, envelope([{ citation: '999 U.S. 999', rank: 1 }]))
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases: [clean, sloppy],
    providerResults
  });
  assert.equal(scored.summary.byDifficulty.clean.positives.hit_at['hit@1'], 1);
  assert.equal(scored.summary.byDifficulty.sloppy.positives.hit_at['hit@1'], 0);
});

test('byAuthority stratifies on authority_identifier', async () => {
  const scotus = positiveCase({ caseId: 'scotus-1', authority_identifier: 'scotus' });
  const nysup = positiveCase({ caseId: 'nysup-1', authority_identifier: 'nysupct' });
  const providerResults = [
    providerResult(scotus.caseId, envelope([{ citation: scotus.metadata.expected.canonical_citation, rank: 1 }])),
    providerResult(nysup.caseId, envelope([]))
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases: [scotus, nysup],
    providerResults
  });
  assert.equal(scored.summary.byAuthority.scotus.positives.hit_at['hit@1'], 1);
  assert.equal(scored.summary.byAuthority.nysupct.positives.hit_at['hit@1'], 0);
});

test('byNegativeCategory groups negatives only', async () => {
  const n1 = negativeCase({ caseId: 'n1', negative_category: 'date_short' });
  const n2 = negativeCase({ caseId: 'n2', negative_category: 'date_short' });
  const n3 = negativeCase({ caseId: 'n3', negative_category: 'volume_only' });
  const providerResults = [
    providerResult(n1.caseId, envelope([])),
    providerResult(n2.caseId, envelope([{ document_uuid: 'x', rank: 1 }])),
    providerResult(n3.caseId, envelope([]))
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases: [n1, n2, n3],
    providerResults
  });
  assert.equal(scored.summary.byNegativeCategory.date_short.n, 2);
  assert.equal(scored.summary.byNegativeCategory.date_short.fp_rate, 0.5);
  assert.equal(scored.summary.byNegativeCategory.volume_only.fp_rate, 0);
});

test('provider_failure case is counted as failure and excluded from positives', async () => {
  const c = positiveCase();
  const providerResults = [
    { caseId: c.caseId, status: 'provider_failure', finalOutputText: null, error: { kind: 'fetch_error' } }
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases: [c],
    providerResults
  });
  const [only] = scored.caseScores;
  assert.equal(only.status, 'provider_failure');
  assert.equal(only.hitRank, null);
  assert.equal(scored.summary.quality.n_failed, 1);
  assert.equal(scored.summary.positives.n, 0);
});

test('filter guard: only cases with benchmarkId=citation-lookup are scored', async () => {
  const ours = positiveCase({ caseId: 'ours' });
  const other = { ...positiveCase({ caseId: 'other' }), benchmarkId: 'other-benchmark' };
  const providerResults = [
    providerResult(ours.caseId, envelope([{ citation: ours.metadata.expected.canonical_citation, rank: 1 }])),
    providerResult(other.caseId, envelope([{ citation: other.metadata.expected.canonical_citation, rank: 1 }]))
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases: [ours, other],
    providerResults
  });
  assert.equal(scored.caseScores.length, 1);
  assert.equal(scored.caseScores[0].caseId, 'ours');
});

test('scoreStream matches score() shape and skips foreign benchmarks', async () => {
  const c = positiveCase();
  const foreign = { ...positiveCase({ caseId: 'foreign' }), benchmarkId: 'other-benchmark' };
  const pairs = [
    { benchmarkCase: c, providerResult: providerResult(c.caseId, envelope([{ citation: '410 U.S. 113', rank: 1 }])) },
    { benchmarkCase: foreign, providerResult: providerResult(foreign.caseId, envelope([{ citation: '999 U.S. 999', rank: 1 }])) }
  ];
  async function* asIterable() {
    for (const pair of pairs) yield pair;
  }
  const scored = await citationLookupScorerAdapter.scoreStream({
    manifest: null,
    pairs: asIterable()
  });
  assert.equal(scored.caseScores.length, 1);
  assert.equal(scored.caseScores[0].caseId, c.caseId);
  assert.equal(scored.summary.headline.hit_at_1, 1);
});

test('exports SUPPORTED_CUTOFFS + SUPPORTED_HEADLINE_CUTOFF for the runner validator', () => {
  assert.deepEqual(SUPPORTED_CUTOFFS, [1, 5, 10, 25]);
  assert.equal(SUPPORTED_HEADLINE_CUTOFF, 1);
  assert.deepEqual(citationLookupScorerAdapter.SUPPORTED_CUTOFFS, [1, 5, 10, 25]);
  assert.equal(citationLookupScorerAdapter.SUPPORTED_HEADLINE_CUTOFF, 1);
});

test('_internals expose cutoff constants', () => {
  assert.deepEqual(_internals.CUTOFFS, [1, 5, 10, 25]);
  assert.equal(_internals.HEADLINE_CUTOFF, 1);
});

test('scoreStream honors manifest.scorer.settings.cutoffs and headline_cutoff', async () => {
  const cases = [
    {
      caseId: 'p-1',
      benchmarkId: 'citation-lookup',
      split: 'test',
      metadata: {
        datasetIndex: 0,
        datasetName: 'citation-lookup-cases',
        document_type: 'case',
        difficulty: 'easy',
        authority_identifier: 'test',
        datasource_id: 'test',
        geo_level_2: 'FED',
        expected: { canonical_citation: '1 Test 1', alternates: [] }
      }
    }
  ];
  const providerResults = [
    {
      caseId: 'p-1',
      status: 'completed',
      finalOutputText: JSON.stringify({
        results: [
          ...Array.from({ length: 74 }, (_, i) => ({ rank: i + 1, citation: `filler ${i}` })),
          { rank: 75, citation: '1 Test 1' }
        ]
      }),
      timing: { durationMs: 10 }
    }
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: {
      run_id: 'cl-cutoff-test',
      scorer: { settings: { cutoffs: [1, 100], headline_cutoff: 100 } }
    },
    cases,
    providerResults
  });
  assert.deepEqual(scored.summary.execution.scorer.cutoffs, [1, 100]);
  assert.equal(scored.summary.execution.scorer.headline_cutoff, 100);
  assert.equal(scored.caseScores[0].hitAt100, true);
  assert.equal(scored.caseScores[0].hitAt1, false);
  assert.equal(scored.summary.overallScore, 1);
});

test('surfaces envelope.provider_ambiguous and reports ambiguous_rate', async () => {
  const cases = [
    {
      caseId: 'a-1',
      benchmarkId: 'citation-lookup',
      split: 'test',
      metadata: {
        datasetIndex: 0,
        datasetName: 'citation-lookup-cases',
        expected: { canonical_citation: '1 Test 1', alternates: [] }
      }
    },
    {
      caseId: 'a-2',
      benchmarkId: 'citation-lookup',
      split: 'test',
      metadata: {
        datasetIndex: 1,
        datasetName: 'citation-lookup-cases',
        expected: { canonical_citation: '2 Test 2', alternates: [] }
      }
    }
  ];
  const providerResults = [
    {
      caseId: 'a-1',
      status: 'completed',
      finalOutputText: JSON.stringify({
        provider_ambiguous: true,
        results: [{ rank: 1, citation: '1 Test 1' }]
      }),
      timing: { durationMs: 10 }
    },
    {
      caseId: 'a-2',
      status: 'completed',
      finalOutputText: JSON.stringify({
        provider_ambiguous: false,
        results: [{ rank: 1, citation: '2 Test 2' }]
      }),
      timing: { durationMs: 10 }
    }
  ];
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases,
    providerResults
  });
  assert.equal(scored.caseScores[0].providerAmbiguous, true);
  assert.equal(scored.caseScores[1].providerAmbiguous, false);
  assert.equal(scored.summary.headline.ambiguous_rate, 0.5);
});

test('ambiguous_rate is null when no positive cases exist to compute the fraction over', async () => {
  const scored = await citationLookupScorerAdapter.score({
    manifest: null,
    cases: [],
    providerResults: []
  });
  assert.equal(scored.summary.headline.ambiguous_rate, null);
});
