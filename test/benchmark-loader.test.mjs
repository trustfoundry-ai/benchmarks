import assert from 'node:assert/strict';
import test from 'node:test';

import { readJson } from '../src/core/fs.mjs';
import { publicSearchCaseQuestionsBenchmarkAdapter } from '../src/adapters/benchmarks/public-search-case-questions.mjs';

test('loads the first 200 public case-question rows deterministically', async () => {
  const config = await readJson('configs/benchmarks/public-search-case-questions-200.json');
  const loaded = await publicSearchCaseQuestionsBenchmarkAdapter.loadCases({
    config,
    repoRoot: process.cwd()
  });
  assert.equal(loaded.cases.length, 200);
  assert.equal(loaded.cases[0].caseId, 'synthetic-search-recall:case_questions:test:76eaa103b27c');
  assert.equal(loaded.cases[0].metadata.document_uuid, 'e09cb8d7-bbff-1bd1-773c-57517679901e');
  assert.equal(loaded.cases[0].metadata.expected.canonical_citation, '13 Mich. 233');
  assert.equal(loaded.cases[0].metadata.state, 'MI');
});
