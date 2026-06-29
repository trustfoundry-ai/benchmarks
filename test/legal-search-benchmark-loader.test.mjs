import assert from 'node:assert/strict';
import test from 'node:test';

import { readJson } from '../src/core/fs.mjs';
import { trustfoundryLegalSearchBenchmarkAdapter } from '../src/adapters/benchmarks/trustfoundry-legal-search.mjs';

async function load(configPath) {
  const config = await readJson(configPath);
  return trustfoundryLegalSearchBenchmarkAdapter.loadCases({
    config,
    repoRoot: process.cwd()
  });
}

test('loads the first 200 key-fact rows deterministically', async () => {
  const loaded = await load('configs/benchmarks/trustfoundry-legal-search-key-facts-200.json');
  assert.equal(loaded.cases.length, 200);
  assert.equal(loaded.benchmark.id, 'trustfoundry-legal-search');
  assert.equal(loaded.cases[0].caseId, 'synthetic-search-recall:case_key_facts:test:77159fbcef36');
  assert.equal(loaded.cases[0].metadata.document_uuid, 'ddbb4997-006f-df1d-9596-8721cabe0abc');
  assert.equal(loaded.cases[0].metadata.expected.canonical_citation, "210 F. App'x 521");
  assert.equal(loaded.cases[0].metadata.doc_type, 'case');
  assert.equal(loaded.cases[0].metadata.field, 'key_facts');
  assert.equal(loaded.cases[0].metadata.model_type, 'case_key_fact');
  assert.equal(loaded.cases[0].metadata.state, 'FED');
});

test('loads law rows with law model metadata', async () => {
  const loaded = await load('configs/benchmarks/trustfoundry-legal-search-laws-200.json');
  assert.equal(loaded.cases.length, 200);
  assert.equal(loaded.cases[0].caseId, 'synthetic-search-recall:laws:test:bac913255273');
  assert.equal(loaded.cases[0].metadata.document_uuid, '3007f525-9be6-fd4a-bd10-6e134719503a');
  assert.equal(loaded.cases[0].metadata.expected.canonical_citation, 'Me. Stat. tit. 24-A, \u00a7 2743-A');
  assert.equal(loaded.cases[0].metadata.doc_type, 'law');
  assert.equal(loaded.cases[0].metadata.model_type, 'law_question');
  assert.equal(loaded.cases[0].metadata.state, 'ME');
});

test('loads regulation rows with regulation model metadata', async () => {
  const loaded = await load('configs/benchmarks/trustfoundry-legal-search-regs-200.json');
  assert.equal(loaded.cases.length, 200);
  assert.equal(loaded.cases[0].caseId, 'synthetic-search-recall:regs:test:7f343deabf23');
  assert.equal(loaded.cases[0].metadata.document_uuid, '9cee5479-ca39-796b-50c6-ac72f921e8c4');
  assert.equal(loaded.cases[0].metadata.expected.canonical_citation, 'N.M. Code R. \u00a7 3.4.22.8');
  assert.equal(loaded.cases[0].metadata.doc_type, 'reg');
  assert.equal(loaded.cases[0].metadata.model_type, 'reg_question');
  assert.equal(loaded.cases[0].metadata.state, 'NM');
});

test('legal search full datasets contain 5000 non-empty prompts each', async () => {
  for (const config of [
    'configs/benchmarks/trustfoundry-legal-search-key-facts-5k.json',
    'configs/benchmarks/trustfoundry-legal-search-laws-5k.json',
    'configs/benchmarks/trustfoundry-legal-search-regs-5k.json'
  ]) {
    const loaded = await load(config);
    assert.equal(loaded.cases.length, 5000, config);
    assert.equal(
      loaded.cases.filter((benchmarkCase) => !benchmarkCase.prompt.trim()).length,
      0,
      config
    );
  }
});
