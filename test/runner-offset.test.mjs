import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { trustfoundryLegalSearchBenchmarkAdapter } from '../src/adapters/benchmarks/trustfoundry-legal-search.mjs';

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

async function makeFixture(rowCount) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'benchmarks-offset-'));
  const dataDir = path.join(tmp, 'data');
  const file = path.join(dataDir, 'case_questions.jsonl');
  const rows = Array.from({ length: rowCount }, (_v, index) => ({
    caseId: `case-${index}`,
    query_text: `question ${index}`,
    doc_type: 'case',
    field: 'questions',
    split: 'test',
    model_type: 'case_question',
    expected: { canonical_citation: `${index + 1} Mich. 1`, alternates: [] }
  }));
  await writeJsonl(file, rows);
  return {
    dataDir,
    cleanup: () => fs.rm(tmp, { recursive: true, force: true })
  };
}

async function loadWith(config, dataDir) {
  return trustfoundryLegalSearchBenchmarkAdapter.loadCases({
    config: { dataDir, ...config },
    repoRoot: process.cwd()
  });
}

test('loadCases returns the full slice when neither limit nor offset is set (regression)', async () => {
  const fixture = await makeFixture(10);
  try {
    const loaded = await loadWith({}, fixture.dataDir);
    assert.equal(loaded.cases.length, 10);
    assert.equal(loaded.cases[0].caseId, 'case-0');
    assert.equal(loaded.cases[9].caseId, 'case-9');
  } finally {
    await fixture.cleanup();
  }
});

test('loadCases with only limit slices from index 0 (regression)', async () => {
  const fixture = await makeFixture(10);
  try {
    const loaded = await loadWith({ limit: 3 }, fixture.dataDir);
    assert.deepEqual(loaded.cases.map((c) => c.caseId), ['case-0', 'case-1', 'case-2']);
  } finally {
    await fixture.cleanup();
  }
});

test('loadCases with offset skips the leading cases', async () => {
  const fixture = await makeFixture(10);
  try {
    const loaded = await loadWith({ offset: 4 }, fixture.dataDir);
    assert.deepEqual(loaded.cases.map((c) => c.caseId), [
      'case-4', 'case-5', 'case-6', 'case-7', 'case-8', 'case-9'
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('loadCases with offset+limit slices a middle chunk', async () => {
  const fixture = await makeFixture(10);
  try {
    const loaded = await loadWith({ offset: 3, limit: 4 }, fixture.dataDir);
    assert.deepEqual(loaded.cases.map((c) => c.caseId), [
      'case-3', 'case-4', 'case-5', 'case-6'
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('loadCases with offset beyond total returns empty', async () => {
  const fixture = await makeFixture(5);
  try {
    const loaded = await loadWith({ offset: 20, limit: 4 }, fixture.dataDir);
    assert.equal(loaded.cases.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('loadCases treats negative offset as 0', async () => {
  const fixture = await makeFixture(5);
  try {
    const loaded = await loadWith({ offset: -2, limit: 3 }, fixture.dataDir);
    assert.deepEqual(loaded.cases.map((c) => c.caseId), ['case-0', 'case-1', 'case-2']);
  } finally {
    await fixture.cleanup();
  }
});
