import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { citationLookupBenchmarkAdapter } from '../src/adapters/benchmarks/citation-lookup.mjs';

async function withFixtureDir(rows, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'citation-lookup-test-'));
  const dataDir = path.join(dir, 'citation-lookup-fixture');
  await writeFile(path.join(dir, 'placeholder'), '');
  const file = path.join(dataDir, 'dataset.jsonl');
  await (async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  })();
  try {
    return await fn({ dir, file });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loads positive case rows and stamps citation_search model_type', async () => {
  const rows = [
    {
      caseId: 'citation-lookup-cases-fed-akb-0001-bluebook',
      query_text: '2016 Bankr. LEXIS 3710',
      expected: {
        kind: 'positive',
        document_type: 'case_law',
        canonical_citation: '2016 Bankr. LEXIS 3710',
        alternates: [],
        datasource_id: 'courtlistener',
        authority_identifier: 'akb',
        geo_level_1: 'us',
        geo_level_2: '',
        difficulty: 'bluebook',
        sloppy_transform: null,
        document_uuid: '0e1387f8-ae3e-a5bf-b875-e26fa2418fea',
        cl_cluster_id: '8527474'
      }
    }
  ];
  await withFixtureDir(rows, async ({ dir, file }) => {
    const loaded = await citationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: file },
      repoRoot: dir
    });
    assert.equal(loaded.cases.length, 1);
    const c = loaded.cases[0];
    assert.equal(c.caseId, 'citation-lookup-cases-fed-akb-0001-bluebook');
    assert.equal(c.prompt, '2016 Bankr. LEXIS 3710');
    assert.equal(c.metadata.model_type, 'citation_search');
    assert.equal(c.metadata.doc_type, 'case_law');
    assert.equal(c.metadata.difficulty, 'bluebook');
    assert.equal(c.metadata.expected.cl_cluster_id, '8527474');
    assert.equal(c.metadata.expected.document_uuid, '0e1387f8-ae3e-a5bf-b875-e26fa2418fea');
    assert.equal(c.metadata.state, 'FED'); // empty geo_level_2 → FED
    assert.equal(c.scoringHints.negative, false);
  });
});

test('geo_level_2 populates state uppercase; empty falls back to FED', async () => {
  const rows = [
    {
      caseId: 'row-a',
      query_text: 'Alaska Stat. § 45.50.300',
      expected: {
        kind: 'positive',
        document_type: 'statute',
        canonical_citation: 'Alaska Stat. § 45.50.300',
        alternates: [],
        authority_identifier: 'www.akleg.gov',
        geo_level_1: 'us',
        geo_level_2: 'ak',
        difficulty: 'bluebook'
      }
    },
    {
      caseId: 'row-b',
      query_text: '5 U.S.C. § 552',
      expected: {
        kind: 'positive',
        document_type: 'statute',
        canonical_citation: '5 U.S.C. § 552',
        alternates: [],
        geo_level_1: 'us',
        geo_level_2: '',
        difficulty: 'bluebook'
      }
    }
  ];
  await withFixtureDir(rows, async ({ dir, file }) => {
    const loaded = await citationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: file },
      repoRoot: dir
    });
    assert.equal(loaded.cases[0].metadata.state, 'AK');
    assert.equal(loaded.cases[1].metadata.state, 'FED');
  });
});

test('negative rows carry kind=negative and scoringHints.negative=true', async () => {
  const rows = [
    {
      caseId: 'citation-lookup-negatives-0001',
      query_text: '555-1234',
      expected: {
        kind: 'negative',
        document_type: null,
        canonical_citation: null,
        alternates: [],
        negative_category: 'phone',
        source_row: 'synthetic-negatives_phone:1'
      }
    }
  ];
  await withFixtureDir(rows, async ({ dir, file }) => {
    const loaded = await citationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: file },
      repoRoot: dir
    });
    const c = loaded.cases[0];
    assert.equal(c.metadata.expected.kind, 'negative');
    assert.equal(c.metadata.negative_category, 'phone');
    assert.equal(c.scoringHints.negative, true);
    assert.equal(c.metadata.model_type, 'citation_search');
    assert.equal(c.metadata.difficulty, null);
  });
});

test('offset + limit slice the loaded cases', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    caseId: `row-${i}`,
    query_text: `q ${i}`,
    expected: {
      kind: 'positive',
      document_type: 'case_law',
      canonical_citation: `cite ${i}`,
      alternates: []
    }
  }));
  await withFixtureDir(rows, async ({ dir, file }) => {
    const loaded = await citationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: file, offset: 1, limit: 2 },
      repoRoot: dir
    });
    assert.equal(loaded.cases.length, 2);
    assert.equal(loaded.cases[0].caseId, 'row-1');
    assert.equal(loaded.cases[1].caseId, 'row-2');
  });
});

test('summary counts break down by document_type, difficulty, and kind', async () => {
  const rows = [
    { caseId: 'a', query_text: 'x', expected: { kind: 'positive', document_type: 'case_law', canonical_citation: 'x', alternates: [], difficulty: 'bluebook' } },
    { caseId: 'b', query_text: 'y', expected: { kind: 'positive', document_type: 'case_law', canonical_citation: 'y', alternates: [], difficulty: 'noisy' } },
    { caseId: 'c', query_text: 'z', expected: { kind: 'negative', document_type: null, canonical_citation: null, alternates: [], negative_category: 'phone' } }
  ];
  await withFixtureDir(rows, async ({ dir, file }) => {
    const loaded = await citationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: file },
      repoRoot: dir
    });
    const { summary } = loaded.inventory;
    assert.equal(summary.total, 3);
    assert.equal(summary.byDocumentType.case_law, 2);
    assert.equal(summary.byDocumentType.unknown, 1);
    assert.equal(summary.byDifficulty.bluebook, 1);
    assert.equal(summary.byDifficulty.noisy, 1);
    assert.equal(summary.byKind.positive, 2);
    assert.equal(summary.byKind.negative, 1);
  });
});
