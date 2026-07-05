import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { trustfoundryCitationLookupBenchmarkAdapter } from '../../../src/adapters/benchmarks/trustfoundry-citation-lookup.mjs';
import { writeJsonl } from '../../../src/core/fs.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'citation-lookup-loader-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function positiveCaseRow(overrides = {}) {
  return {
    caseId: 'citation-lookup-cases-fed-scotus-0001-clean',
    query_text: '410 U.S. 113',
    expected: {
      alternates: [],
      authority_identifier: 'scotus',
      canonical_citation: '410 U.S. 113',
      cl_cluster_id: '108713',
      datasource_id: 'sample-cases',
      difficulty: 'clean',
      document_type: 'case_law',
      document_uuid: '00000000-0000-4000-8000-000000000001',
      geo_level_1: 'us',
      geo_level_2: '',
      kind: 'positive',
      source_row: 'cases:1'
    },
    ...overrides
  };
}

function statuteRow() {
  return {
    caseId: 'citation-lookup-statutes-ak-0001-clean',
    query_text: 'Alaska Stat. § 45.50.300',
    expected: {
      alternates: [],
      authority_identifier: 'www.akleg.gov',
      canonical_citation: 'Alaska Stat. § 45.50.300',
      datasource_id: 'ak-laws',
      difficulty: 'clean',
      document_type: 'statute',
      geo_level_1: 'us',
      geo_level_2: 'ak',
      kind: 'positive',
      source_row: 'laws:1'
    }
  };
}

function regulationRow() {
  return {
    caseId: 'citation-lookup-regulations-ak-0001-sloppy',
    query_text: 'alaska admin code tit. 11, § 86505',
    expected: {
      alternates: [],
      authority_identifier: 'www.akleg.gov',
      canonical_citation: 'Alaska Admin. Code tit. 11, § 86.505',
      datasource_id: 'ak-regs',
      difficulty: 'sloppy',
      document_type: 'regulation',
      geo_level_1: 'us',
      geo_level_2: 'ak',
      kind: 'positive',
      source_row: 'regs:1'
    }
  };
}

function negativeRow() {
  return {
    caseId: 'citation-lookup-negatives-0001',
    query_text: 'October 4, 2019',
    expected: {
      alternates: [],
      canonical_citation: null,
      document_type: null,
      kind: 'negative',
      negative_category: 'date_long',
      source_row: 'synthetic-negatives_date_long:1'
    }
  };
}

test('loads a single dataset with correct case/metadata shape', async () => {
  await withTempDir(async (root) => {
    const dsDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'cases');
    await mkdir(dsDir, { recursive: true });
    const file = path.join(dsDir, 'dataset.jsonl');
    await writeJsonl(file, [positiveCaseRow()]);

    const { cases, benchmark, inventory } = await trustfoundryCitationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: 'data/trustfoundry-citation-lookup/cases/dataset.jsonl' },
      repoRoot: root
    });

    assert.equal(cases.length, 1);
    const [only] = cases;
    assert.equal(only.caseId, 'citation-lookup-cases-fed-scotus-0001-clean');
    assert.equal(only.benchmarkId, 'trustfoundry-citation-lookup');
    assert.equal(only.prompt, '410 U.S. 113');
    assert.equal(only.metadata.model_type, 'citation_search');
    assert.equal(only.metadata.document_type, 'case_law');
    assert.equal(only.metadata.difficulty, 'clean');
    assert.equal(only.metadata.authority_identifier, 'scotus');
    assert.equal(only.metadata.cl_cluster_id, '108713');
    assert.equal(only.metadata.document_uuid, '00000000-0000-4000-8000-000000000001');
    assert.equal(only.metadata.geo_level_2, 'FED', 'empty geo_level_2 should normalize to FED');
    assert.equal(only.metadata.datasetName, 'cases');
    assert.equal(only.metadata.kind, 'positive');
    assert.deepEqual(only.metadata.expected, positiveCaseRow().expected);

    assert.equal(benchmark.id, 'trustfoundry-citation-lookup');
    assert.equal(inventory.summary.total, 1);
    assert.equal(inventory.summary.byDocType.case_law, 1);
  });
});

test('geo normalization: non-empty geo_level_2 uppercases; empty becomes FED', async () => {
  await withTempDir(async (root) => {
    const dsDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'statutes');
    await mkdir(dsDir, { recursive: true });
    await writeJsonl(path.join(dsDir, 'dataset.jsonl'), [statuteRow(), positiveCaseRow()]);

    const { cases } = await trustfoundryCitationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: 'data/trustfoundry-citation-lookup/statutes/dataset.jsonl' },
      repoRoot: root
    });

    assert.equal(cases[0].metadata.geo_level_2, 'AK');
    assert.equal(cases[1].metadata.geo_level_2, 'FED');
  });
});

test('negatives propagate kind and negative_category', async () => {
  await withTempDir(async (root) => {
    const dsDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'negatives');
    await mkdir(dsDir, { recursive: true });
    await writeJsonl(path.join(dsDir, 'dataset.jsonl'), [negativeRow()]);

    const { cases } = await trustfoundryCitationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: 'data/trustfoundry-citation-lookup/negatives/dataset.jsonl' },
      repoRoot: root
    });

    assert.equal(cases[0].metadata.kind, 'negative');
    assert.equal(cases[0].metadata.negative_category, 'date_long');
    assert.equal(cases[0].split, 'negative');
    assert.equal(cases[0].expectedAnswer, null);
  });
});

test('datasetPaths combined config stitches rows and tags per-dataset name', async () => {
  await withTempDir(async (root) => {
    const casesDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'cases');
    const statutesDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'statutes');
    const regsDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'regulations');
    const negsDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'negatives');
    for (const d of [casesDir, statutesDir, regsDir, negsDir]) {
      await mkdir(d, { recursive: true });
    }
    await writeJsonl(path.join(casesDir, 'dataset.jsonl'), [positiveCaseRow()]);
    await writeJsonl(path.join(statutesDir, 'dataset.jsonl'), [statuteRow()]);
    await writeJsonl(path.join(regsDir, 'dataset.jsonl'), [regulationRow()]);
    await writeJsonl(path.join(negsDir, 'dataset.jsonl'), [negativeRow()]);

    const { cases, inventory } = await trustfoundryCitationLookupBenchmarkAdapter.loadCases({
      config: {
        datasetPaths: [
          'data/trustfoundry-citation-lookup/cases/dataset.jsonl',
          'data/trustfoundry-citation-lookup/statutes/dataset.jsonl',
          'data/trustfoundry-citation-lookup/regulations/dataset.jsonl',
          'data/trustfoundry-citation-lookup/negatives/dataset.jsonl'
        ]
      },
      repoRoot: root
    });

    assert.equal(cases.length, 4);
    assert.deepEqual(
      cases.map((c) => c.metadata.datasetName),
      ['cases', 'statutes', 'regulations', 'negatives']
    );
    assert.equal(inventory.summary.total, 4);
    assert.equal(inventory.summary.byKind.positive, 3);
    assert.equal(inventory.summary.byKind.negative, 1);
  });
});

test('limit config caps case count', async () => {
  await withTempDir(async (root) => {
    const dsDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'cases');
    await mkdir(dsDir, { recursive: true });
    const rows = Array.from({ length: 5 }, (_, i) =>
      positiveCaseRow({ caseId: `cases-${i}` })
    );
    await writeJsonl(path.join(dsDir, 'dataset.jsonl'), rows);

    const { cases, inventory } = await trustfoundryCitationLookupBenchmarkAdapter.loadCases({
      config: { datasetPath: 'data/trustfoundry-citation-lookup/cases/dataset.jsonl', limit: 2 },
      repoRoot: root
    });

    assert.equal(cases.length, 2);
    assert.equal(inventory.summary.available_skipped, 3);
  });
});

test('missing dataset file throws a clear error', async () => {
  await withTempDir(async (root) => {
    await assert.rejects(
      trustfoundryCitationLookupBenchmarkAdapter.loadCases({
        config: { datasetPath: 'data/trustfoundry-citation-lookup/cases/dataset.jsonl' },
        repoRoot: root
      }),
      /trustfoundry-citation-lookup dataset not found/
    );
  });
});

test('config missing both datasetPath and datasetPaths throws', async () => {
  await assert.rejects(
    trustfoundryCitationLookupBenchmarkAdapter.loadCases({ config: {}, repoRoot: '/tmp' }),
    /datasetPath/
  );
});

test('malformed JSONL line surfaces from shared readJsonl', async () => {
  await withTempDir(async (root) => {
    const dsDir = path.join(root, 'data', 'trustfoundry-citation-lookup', 'cases');
    await mkdir(dsDir, { recursive: true });
    const validLine = JSON.stringify(positiveCaseRow());
    const content = `${validLine}\n{not-json\n${validLine}\n`;
    await writeFile(path.join(dsDir, 'dataset.jsonl'), content, 'utf8');

    await assert.rejects(
      trustfoundryCitationLookupBenchmarkAdapter.loadCases({
        config: { datasetPath: 'data/trustfoundry-citation-lookup/cases/dataset.jsonl' },
        repoRoot: root
      }),
      /Invalid JSONL|JSON|Unexpected token/
    );
  });
});
