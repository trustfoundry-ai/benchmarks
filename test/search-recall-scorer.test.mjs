import assert from 'node:assert/strict';
import test from 'node:test';

import { searchRecallScorerAdapter } from '../src/adapters/scorers/search-recall.mjs';

test('scores by expected document UUID or citation and reports hit@k/MRR', async () => {
  const scores = await searchRecallScorerAdapter.score({
    manifest: { run_id: 'test-run' },
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
        timing: { durationMs: 100 }
      },
      {
        caseId: 'citation-case',
        status: 'completed',
        finalOutputText: JSON.stringify({
          results: [
            { rank: 1, citation: '3 Test 3' }
          ]
        }),
        timing: { durationMs: 100 }
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
        timing: { durationMs: 100 }
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
  assert.deepEqual(scores.summary.execution.scorer.cutoffs, [1, 5, 10, 25]);
});
