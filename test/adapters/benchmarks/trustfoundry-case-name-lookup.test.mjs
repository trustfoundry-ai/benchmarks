import assert from 'node:assert/strict';
import test from 'node:test';

import {
  caseNameLookupBenchmarkAdapter,
  _internals
} from '../../../src/adapters/benchmarks/trustfoundry-case-name-lookup.mjs';
import { _internals as providerInternals } from '@trustfoundry-ai/benchmarks-harness/adapters/providers/trustfoundry-legal-search';

const { buildCase } = _internals;
const { stateForCase } = providerInternals;

function positiveRow(overrides = {}) {
  return {
    caseId: 'case-name-qualified-ca5-0001-clean',
    query_text: 'Roe vs. Wade',
    expected: {
      kind: 'positive',
      tier: 'qualified',
      case_name: 'Roe v. Wade',
      name_transform: null,
      authority_identifier: 'ca5',
      court_name: 'Fifth Circuit',
      year_filed: 1973,
      geo_level_1_identifier: 'us',
      geo_level_2_identifier: '',
      datasource_id: 'courtlistener',
      citation_form: 'reporter',
      corpus_cluster_size: 1,
      jurisdiction_cluster_size: 1,
      gold_citations: [{ canonical_citation: '410 U.S. 113', alternates: ['93 S. Ct. 705'] }],
      avoid_citations: [],
      provenance: { document_uuids: ['abc'], probe_docs_truncated: false },
      ...overrides
    }
  };
}

test('prompt comes from row.query_text, not expected.case_name (0.0-baseline bug)', () => {
  const row = positiveRow();
  assert.equal(row.query_text, 'Roe vs. Wade');
  assert.equal(row.expected.case_name, 'Roe v. Wade');

  const benchmarkCase = buildCase(row, { index: 0, datasetLabel: 'qualified' });

  assert.equal(benchmarkCase.prompt, 'Roe vs. Wade');
  assert.notEqual(benchmarkCase.prompt, row.expected.case_name);
});

test('a federal row (empty geo_level_2_identifier) yields state FED and jurisdiction_id us', () => {
  const row = positiveRow({ geo_level_2_identifier: '' });
  const benchmarkCase = buildCase(row, { index: 0, datasetLabel: 'qualified' });

  // The gold CSV renders a federal row's database NULL as ''. That must not
  // survive into metadata.geo_level_2_identifier as '' -- the harness
  // provider's stateForCase does
  // `metadata.geo_level_2_identifier ?? expected.state ?? metadata.state`,
  // and '' is not nullish, so it would short-circuit the chain before ever
  // reaching metadata.state (== 'FED') and the provider would throw
  // "state_filter_enabled=true but case <id> has no usable state" for every
  // federal row. null is the value that lets '??' fall through as intended.
  assert.equal(benchmarkCase.metadata.geo_level_2_identifier, null);
  assert.equal(benchmarkCase.metadata.state, 'FED');
  assert.equal(benchmarkCase.metadata.jurisdiction_id, 'us');
});

test('metadata.geo_level_2_identifier is emitted at the metadata top level, matching the row value', () => {
  const row = positiveRow({ geo_level_2_identifier: 'fl' });
  const benchmarkCase = buildCase(row, { index: 0, datasetLabel: 'qualified' });

  assert.equal(benchmarkCase.metadata.geo_level_2_identifier, 'fl');
  // Not just nested under metadata.expected -- the top-level key must exist directly.
  assert.ok(Object.prototype.hasOwnProperty.call(benchmarkCase.metadata, 'geo_level_2_identifier'));
});

test('a state row (geo_level_2_identifier: fl) yields state FL and jurisdiction_id fl', () => {
  const row = positiveRow({ geo_level_2_identifier: 'fl' });
  const benchmarkCase = buildCase(row, { index: 0, datasetLabel: 'qualified' });

  assert.equal(benchmarkCase.metadata.state, 'FL');
  assert.equal(benchmarkCase.metadata.jurisdiction_id, 'fl');
});

test('geo_level_1_identifier is never used as the jurisdiction', () => {
  const row = positiveRow({ geo_level_1_identifier: 'zz', geo_level_2_identifier: 'fl' });
  const benchmarkCase = buildCase(row, { index: 0, datasetLabel: 'qualified' });

  assert.equal(benchmarkCase.metadata.jurisdiction_id, 'fl');
  assert.notEqual(benchmarkCase.metadata.jurisdiction_id, 'zz');
});

test('allowedAnswers flattens every gold entry (canonical + alternates), deduped, no nulls', () => {
  const row = {
    caseId: 'case-name-ambiguous-scotus-0001-clean',
    query_text: 'Uyeki v. Styer',
    expected: {
      kind: 'positive',
      tier: 'ambiguous',
      name_transform: null,
      gold_citations: [
        { canonical_citation: '1946 U.S. LEXIS 1624', alternates: [] },
        { canonical_citation: '1946 U.S. LEXIS 2201', alternates: [] },
        {
          canonical_citation: '1947 U.S. LEXIS 2798',
          alternates: ['67 S. Ct. 486', '91 L. Ed. 604', '1947 U.S. LEXIS 2798']
        }
      ]
    }
  };

  const benchmarkCase = buildCase(row, { index: 0, datasetLabel: 'ambiguous' });

  assert.deepEqual(benchmarkCase.allowedAnswers, [
    '1946 U.S. LEXIS 1624',
    '1946 U.S. LEXIS 2201',
    '1947 U.S. LEXIS 2798',
    '67 S. Ct. 486',
    '91 L. Ed. 604'
  ]);
  assert.ok(!benchmarkCase.allowedAnswers.includes(null));
  assert.ok(!benchmarkCase.allowedAnswers.includes(undefined));
});

test('scoringHints.negative is true for exactly the right kind', () => {
  // `precision` is not a row kind this suite produces any more -- the scorer
  // has no branch for it (an unrecognized `kind` throws; see scoreCase) --
  // so `scoringHints` only ever needs to distinguish negative from positive.
  const negativeRow = {
    caseId: 'case-name-negative-synthetic_name-0001',
    query_text: 'Ashgrove v. Cascade Industries',
    expected: {
      kind: 'negative',
      tier: 'negatives',
      name_transform: null,
      negative_category: 'synthetic_name',
      gold_citations: []
    }
  };
  const positiveRowCase = positiveRow();

  const negativeCase = buildCase(negativeRow, { index: 0, datasetLabel: 'negatives' });
  const positiveCase = buildCase(positiveRowCase, { index: 0, datasetLabel: 'qualified' });

  assert.equal(negativeCase.scoringHints.negative, true);
  assert.equal(positiveCase.scoringHints.negative, false);

  // expectedAnswer is null for negative, populated for positive.
  assert.equal(negativeCase.expectedAnswer, null);
  assert.equal(positiveCase.expectedAnswer, '410 U.S. 113');
});

test("model_type is 'case_name' for every row, regardless of kind or tier", () => {
  const rows = [
    positiveRow(),
    {
      caseId: 'case-name-negative-synthetic_name-0001',
      query_text: 'Ashgrove v. Cascade Industries',
      expected: { kind: 'negative', tier: 'negatives', name_transform: null, gold_citations: [] }
    }
  ];

  for (const row of rows) {
    const benchmarkCase = buildCase(row, { index: 0, datasetLabel: row.expected.tier });
    assert.equal(benchmarkCase.metadata.model_type, 'case_name');
    assert.notEqual(benchmarkCase.metadata.model_type, 'citation_search');
  }
});

test('rows carry model_type case_name, not case_question', () => {
  // `case_name` is the value both the public search API and the downstream
  // agent service expect for this benchmark's rows. `state` stays required
  // either way -- both layers exempt only citation_search.
  const row = positiveRow();
  const benchmarkCase = buildCase(row, { index: 0, datasetLabel: 'qualified' });
  assert.equal(benchmarkCase.metadata.model_type, 'case_name');
});

test('caseId passthrough: the adapter does not regenerate ids', () => {
  const row = positiveRow();
  const benchmarkCase = buildCase(row, { index: 7, datasetLabel: 'qualified' });

  assert.equal(benchmarkCase.caseId, row.caseId);
});

test('the harness provider itself resolves state FED for a federal row and FL for a state row', () => {
  // Exercises the real consumer (the harness's own stateForCase), not a
  // re-implementation of it. Checking only the adapter's own metadata fields
  // cannot catch the two sides disagreeing about what a federal or state row
  // looks like -- only feeding the adapter's built case into the harness's
  // stateForCase proves they agree.
  const federalCase = buildCase(positiveRow({ geo_level_2_identifier: '' }), {
    index: 0,
    datasetLabel: 'qualified'
  });
  assert.equal(stateForCase(federalCase), 'FED');

  const stateCase = buildCase(positiveRow({ geo_level_2_identifier: 'fl' }), {
    index: 0,
    datasetLabel: 'qualified'
  });
  assert.equal(stateForCase(stateCase), 'FL');
});

test('loadCases offset/limit slice the same way as citation-lookup.mjs', async () => {
  const repoRoot = new URL('../../../', import.meta.url).pathname;
  const result = await caseNameLookupBenchmarkAdapter.loadCases({
    config: {
      datasetPath: 'data/trustfoundry-case-name-lookup/v2-negatives.jsonl',
      datasetLabel: 'negatives',
      offset: 2,
      limit: 3
    },
    repoRoot
  });

  assert.equal(result.cases.length, 3);
  assert.equal(result.cases[0].metadata.datasetIndex, 2);
  assert.equal(result.cases[2].metadata.datasetIndex, 4);
});
