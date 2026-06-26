import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { readJsonl } from '../../core/fs.mjs';
import { applyQueryTransform } from '../../core/query-transforms.mjs';

const DEFAULT_DATA_DIR = 'data/public-search-case-questions-5k';
const DEFAULT_FILES = ['case_questions.jsonl'];

function normalizeList(value) {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function fileStem(file) {
  return path.basename(file, path.extname(file));
}

function upperState(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toUpperCase()
    : null;
}

function stateForRow(row) {
  const configuredState = upperState(row.state);
  if (configuredState) return configuredState;
  const geo2 = upperState(row.geo_level_2_identifier);
  if (geo2) return geo2;
  if ((row.doc_type ?? row.document_type) === 'case') return 'FED';
  return 'FED';
}

function jurisdictionIdForRow(row) {
  const state = stateForRow(row);
  return state === 'FED' ? 'us' : state.toLowerCase();
}

async function resolveDatasetFiles(config, repoRoot) {
  const dataDir = config.dataDir ?? config.datasetDir ?? DEFAULT_DATA_DIR;
  const resolvedDir = path.isAbsolute(dataDir)
    ? dataDir
    : path.resolve(repoRoot, dataDir);
  const stats = await stat(resolvedDir).catch((error) => {
    throw new Error(`Dataset directory not found at ${resolvedDir}: ${error.message}`);
  });
  if (!stats.isDirectory()) throw new Error(`Dataset path is not a directory: ${resolvedDir}`);

  if (config.files) {
    return {
      dataDir: resolvedDir,
      files: config.files.map((file) =>
        path.isAbsolute(file) ? file : path.join(resolvedDir, file)
      )
    };
  }

  const entries = await readdir(resolvedDir);
  const jsonl = entries.filter((entry) => entry.endsWith('.jsonl')).sort();
  return {
    dataDir: resolvedDir,
    files: (jsonl.length ? jsonl : DEFAULT_FILES).map((file) => path.join(resolvedDir, file))
  };
}

function configuredQueryTransformId(config) {
  return config.query_transform_id ?? config.queryTransformId ?? null;
}

function buildCase(row, { datasetName, index, datasetSize, queryTransformId }) {
  const expected = row.expected ?? {};
  const canonical = expected.canonical_citation ?? row.canonical_citation ?? null;
  const alternates = expected.alternates ?? row.alternate_citations ?? [];
  const docType = row.doc_type ?? row.document_type ?? null;
  const field = row.field ?? null;
  const split = row.split ?? 'unknown';
  const modelType = row.model_type ?? 'case_question';
  const caseId =
    row.caseId ??
    row.case_id ??
    `public-search-case-questions:${datasetName}:${split}:${index}`;
  const rawQuery = row.query_text ?? row.query ?? row.prompt ?? '';
  const queryTransform = applyQueryTransform(rawQuery, queryTransformId);
  const transformMetadata = queryTransformId
    ? {
        raw_query: queryTransform.rawQuery,
        search_query: queryTransform.searchQuery,
        query_transform_id: queryTransform.id,
        query_transform: {
          id: queryTransform.id,
          transformed: queryTransform.transformed,
          rules_applied: queryTransform.rulesApplied,
          removed_prefixes: queryTransform.removedPrefixes
        }
      }
    : {};

  return {
    caseId,
    benchmarkId: 'public-search-case-questions',
    taskId: `${docType ?? 'unknown'}:${field ?? datasetName}`,
    split,
    prompt: queryTransform.searchQuery,
    expectedAnswer: canonical,
    allowedAnswers: [canonical, ...alternates].filter(Boolean),
    metadata: {
      ...transformMetadata,
      datasetName,
      datasetSize,
      datasetIndex: index,
      source_dataset: row.source_dataset ?? datasetName,
      source_index: row.source_index ?? null,
      document_title: row.document_title ?? null,
      document_uuid: row.document_uuid ?? null,
      document_chunk_id: row.document_chunk_id ?? null,
      document_chunk_tag: row.document_chunk_tag ?? null,
      datasource_id: row.datasource_id ?? null,
      authority_identifier: row.authority_identifier ?? null,
      geo_level_1_identifier: row.geo_level_1_identifier ?? null,
      geo_level_2_identifier: row.geo_level_2_identifier ?? null,
      geo_level_3_identifier: row.geo_level_3_identifier ?? null,
      geo_level_4_identifier: row.geo_level_4_identifier ?? null,
      court_id: docType === 'case' ? (row.authority_identifier ?? null) : null,
      jurisdiction_id: jurisdictionIdForRow(row),
      doc_type: docType,
      field,
      model_type: modelType,
      document_date: row.document_date ?? row.published_date ?? null,
      published_date: row.published_date ?? row.document_date ?? null,
      state: stateForRow(row),
      expected: {
        kind: 'exact',
        canonical_citation: canonical,
        alternates
      }
    },
    scoringHints: { kind: 'search-recall', outputMode: 'json' }
  };
}

function includeCase(benchmarkCase, filters) {
  if (filters.splits && !filters.splits.includes(benchmarkCase.split)) return false;
  if (
    filters.datasetNames &&
    !filters.datasetNames.includes(benchmarkCase.metadata.datasetName)
  ) {
    return false;
  }
  return true;
}

function summaryFor(cases, allCases) {
  const byDataset = {};
  const bySplit = {};
  for (const item of cases) {
    byDataset[item.metadata.datasetName ?? 'unknown'] =
      (byDataset[item.metadata.datasetName ?? 'unknown'] ?? 0) + 1;
    bySplit[item.split ?? 'unknown'] = (bySplit[item.split ?? 'unknown'] ?? 0) + 1;
  }
  return {
    total: cases.length,
    selected: cases.length,
    available_skipped: Math.max(allCases.length - cases.length, 0),
    byDataset,
    bySplit
  };
}

export const publicSearchCaseQuestionsBenchmarkAdapter = {
  id: 'public-search-case-questions',
  version: 'public-search-case-questions-v1',
  materializationVersion: 'public-search-case-questions-data-v1',

  async loadCases({ config, repoRoot }) {
    const datasetSize = config.datasetSize ?? path.basename(config.dataDir ?? DEFAULT_DATA_DIR);
    const { dataDir, files } = await resolveDatasetFiles(config, repoRoot);
    const queryTransformId = configuredQueryTransformId(config);
    const filters = {
      splits: normalizeList(config.splits),
      datasetNames: normalizeList(config.datasetNames)
    };
    const allCases = [];
    for (const file of files) {
      const datasetName = fileStem(file);
      const rows = await readJsonl(file);
      rows.forEach((row, index) => {
        allCases.push(buildCase(row, {
          datasetName,
          index,
          datasetSize,
          queryTransformId
        }));
      });
    }
    const selected = allCases.filter((benchmarkCase) => includeCase(benchmarkCase, filters));
    const limit = Number.isInteger(config.limit) ? config.limit : null;
    const cases = limit === null ? selected : selected.slice(0, limit);

    return {
      benchmark: {
        id: this.id,
        version: this.version,
        sourceRoot: dataDir,
        sourceFiles: files,
        materializationVersion: this.materializationVersion,
        queryTransformId
      },
      inventory: {
        benchmark: this.id,
        sourceRoot: dataDir,
        records: cases.map((item) => ({
          id: item.caseId,
          benchmark: item.benchmarkId,
          status: 'selected',
          selected: true,
          skipReasons: []
        })),
        summary: summaryFor(cases, allCases)
      },
      cases
    };
  }
};
