import path from 'node:path';
import { stat } from 'node:fs/promises';

import { readJsonl } from '../../core/fs.mjs';

const BENCHMARK_ID = 'citation-lookup';
const VERSION = 'citation-lookup-v1';
const MATERIALIZATION_VERSION = 'citation-lookup-data-v1';

const DOCUMENT_TYPE_TO_MODEL_TYPE = {
  case_law: 'citation_search',
  statute: 'citation_search',
  regulation: 'citation_search'
};

function upperState(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length ? trimmed : null;
}

function stateForRow(row) {
  const expected = row.expected ?? {};
  const geo2 = upperState(expected.geo_level_2);
  if (geo2) return geo2;
  const geo1 = upperState(expected.geo_level_1);
  if (geo1 === 'US' || geo1 === 'USA' || geo1 === 'FEDERAL') return 'FED';
  return 'FED';
}

function difficultyForRow(row) {
  const expected = row.expected ?? {};
  if (expected.kind === 'negative') return null;
  return expected.difficulty ?? null;
}

function documentTypeForRow(row) {
  const expected = row.expected ?? {};
  return expected.document_type ?? null;
}

function modelTypeForRow(row) {
  const docType = documentTypeForRow(row);
  return DOCUMENT_TYPE_TO_MODEL_TYPE[docType] ?? 'citation_search';
}

function buildCase(row, { index, datasetLabel }) {
  const expected = row.expected ?? {};
  const canonical = expected.canonical_citation ?? null;
  const alternates = Array.isArray(expected.alternates) ? expected.alternates : [];
  const caseId = row.caseId ?? row.case_id ?? `${BENCHMARK_ID}:${datasetLabel}:${index}`;
  const prompt = row.query_text ?? row.query ?? row.prompt ?? '';
  const state = stateForRow(row);
  const modelType = modelTypeForRow(row);
  const isNegative = expected.kind === 'negative';

  return {
    caseId,
    benchmarkId: BENCHMARK_ID,
    taskId: `${expected.document_type ?? 'negative'}:${expected.difficulty ?? 'na'}`,
    split: 'test',
    prompt,
    expectedAnswer: canonical,
    allowedAnswers: [canonical, ...alternates].filter(Boolean),
    metadata: {
      datasetLabel,
      datasetIndex: index,
      document_uuid: expected.document_uuid ?? null,
      datasource_id: expected.datasource_id ?? null,
      authority_identifier: expected.authority_identifier ?? null,
      geo_level_1_identifier: expected.geo_level_1 ?? null,
      geo_level_2_identifier: expected.geo_level_2 ?? null,
      state,
      doc_type: expected.document_type ?? null,
      difficulty: difficultyForRow(row),
      sloppy_transform: expected.sloppy_transform ?? null,
      negative_category: expected.negative_category ?? null,
      model_type: modelType,
      expected: {
        kind: expected.kind ?? 'positive',
        document_type: expected.document_type ?? null,
        canonical_citation: canonical,
        alternates,
        document_uuid: expected.document_uuid ?? null,
        cl_cluster_id: expected.cl_cluster_id ?? null,
        difficulty: expected.difficulty ?? null,
        negative_category: expected.negative_category ?? null,
        source_row: expected.source_row ?? null
      }
    },
    scoringHints: {
      kind: 'citation-lookup',
      outputMode: 'json',
      negative: isNegative
    }
  };
}

async function resolveDatasetPath(config, repoRoot) {
  const raw =
    config.datasetPath ??
    config.dataset_path ??
    (config.dataDir && config.files?.[0] ? path.join(config.dataDir, config.files[0]) : null);
  if (!raw) {
    throw new Error(
      "citation-lookup benchmark config requires 'datasetPath' (or 'dataDir' + 'files')"
    );
  }
  const abs = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  const stats = await stat(abs).catch((error) => {
    throw new Error(`citation-lookup dataset not found at ${abs}: ${error.message}`);
  });
  if (!stats.isFile()) {
    throw new Error(`citation-lookup datasetPath is not a file: ${abs}`);
  }
  return abs;
}

function summaryFor(cases) {
  const byDocumentType = {};
  const byDifficulty = {};
  const byKind = {};
  for (const item of cases) {
    const docType = item.metadata.doc_type ?? 'unknown';
    const difficulty = item.metadata.difficulty ?? 'na';
    const kind = item.metadata.expected?.kind ?? 'unknown';
    byDocumentType[docType] = (byDocumentType[docType] ?? 0) + 1;
    byDifficulty[difficulty] = (byDifficulty[difficulty] ?? 0) + 1;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return {
    total: cases.length,
    selected: cases.length,
    byDocumentType,
    byDifficulty,
    byKind
  };
}

export const citationLookupBenchmarkAdapter = {
  id: BENCHMARK_ID,
  version: VERSION,
  materializationVersion: MATERIALIZATION_VERSION,

  async loadCases({ config, repoRoot }) {
    const datasetPath = await resolveDatasetPath(config, repoRoot);
    const datasetLabel =
      config.datasetLabel ?? config.dataset_label ?? path.basename(path.dirname(datasetPath));
    const rows = await readJsonl(datasetPath);
    const allCases = rows.map((row, index) => buildCase(row, { index, datasetLabel }));
    const offset = Number.isInteger(config.offset) && config.offset > 0 ? config.offset : 0;
    const limit = Number.isInteger(config.limit) ? config.limit : null;
    const cases = limit === null ? allCases.slice(offset) : allCases.slice(offset, offset + limit);

    return {
      benchmark: {
        id: this.id,
        version: this.version,
        sourceRoot: path.dirname(datasetPath),
        sourceFiles: [datasetPath],
        materializationVersion: this.materializationVersion,
        datasetLabel
      },
      inventory: {
        benchmark: this.id,
        sourceRoot: path.dirname(datasetPath),
        records: cases.map((item) => ({
          id: item.caseId,
          benchmark: item.benchmarkId,
          status: 'selected',
          selected: true,
          skipReasons: []
        })),
        summary: summaryFor(cases)
      },
      cases
    };
  }
};

export const _internals = {
  buildCase,
  stateForRow,
  modelTypeForRow,
  documentTypeForRow,
  difficultyForRow,
  resolveDatasetPath,
  summaryFor
};
