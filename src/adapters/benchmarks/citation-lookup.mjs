import { stat } from 'node:fs/promises';
import path from 'node:path';

import { readJsonl } from '../../core/fs.mjs';

const BENCHMARK_ID = 'citation-lookup';
const VERSION = 'citation-lookup-v1';

function fileStem(file) {
  return path.basename(file, path.extname(file));
}

function datasetNameFor(filePath) {
  const parent = path.basename(path.dirname(filePath));
  if (parent && parent.startsWith('citation-lookup-')) return parent;
  return fileStem(filePath);
}

function normalizeGeo(value) {
  if (typeof value !== 'string') return 'FED';
  const trimmed = value.trim();
  if (!trimmed) return 'FED';
  return trimmed.toUpperCase();
}

async function resolveDatasetPaths(config, repoRoot) {
  const configured = Array.isArray(config.datasetPaths) && config.datasetPaths.length
    ? config.datasetPaths
    : config.datasetPath
      ? [config.datasetPath]
      : null;
  if (!configured) {
    throw new Error(
      "citation-lookup: config must specify 'datasetPath' or 'datasetPaths'"
    );
  }
  const base = repoRoot ?? process.cwd();
  const resolved = [];
  for (const p of configured) {
    const abs = path.isAbsolute(p) ? p : path.resolve(base, p);
    const stats = await stat(abs).catch((error) => {
      throw new Error(
        `citation-lookup dataset not found at ${abs}. (${error.message})`
      );
    });
    if (!stats.isFile()) {
      throw new Error(`citation-lookup dataset path is not a regular file: ${abs}`);
    }
    resolved.push(abs);
  }
  return resolved;
}

function buildCase(row, { filePath, index }) {
  const expected = row.expected ?? {};
  const queryText = row.query_text ?? '';
  const caseId = row.caseId ?? `${datasetNameFor(filePath)}:row-${index}`;
  return {
    caseId,
    benchmarkId: BENCHMARK_ID,
    taskId: 'citation_search',
    split: expected.kind === 'negative' ? 'negative' : 'positive',
    prompt: queryText,
    attachments: [],
    expectedAnswer: expected.canonical_citation ?? null,
    allowedAnswers: [expected.canonical_citation, ...(expected.alternates ?? [])].filter(Boolean),
    metadata: {
      expected,
      model_type: 'citation_search',
      document_type: expected.document_type ?? null,
      difficulty: expected.difficulty ?? null,
      authority_identifier: expected.authority_identifier ?? null,
      datasource_id: expected.datasource_id ?? null,
      geo_level_1: expected.geo_level_1 ?? null,
      geo_level_2: normalizeGeo(expected.geo_level_2),
      kind: expected.kind ?? null,
      negative_category: expected.negative_category ?? null,
      document_uuid: expected.document_uuid ?? null,
      cl_cluster_id: expected.cl_cluster_id ?? null,
      datasetName: datasetNameFor(filePath),
      datasetIndex: index,
      source_row: expected.source_row ?? null,
      state: normalizeGeo(expected.geo_level_2)
    },
    scoringHints: { kind: 'citation-lookup', outputMode: 'json' }
  };
}

export const citationLookupBenchmarkAdapter = {
  id: BENCHMARK_ID,
  version: VERSION,
  promptVersion: 'citation-lookup-prompt-v1',
  materializationVersion: 'citation-lookup-data-v1',

  async loadCases({ config, repoRoot }) {
    const files = await resolveDatasetPaths(config, repoRoot);
    const allCases = [];
    for (const file of files) {
      const rows = await readJsonl(file);
      rows.forEach((row, index) => {
        allCases.push(buildCase(row, { filePath: file, index }));
      });
    }
    const limit = Number.isInteger(config.limit) ? config.limit : null;
    const cases = limit !== null ? allCases.slice(0, limit) : allCases;

    const byDataset = {};
    const byKind = {};
    const byDocType = {};
    for (const item of cases) {
      const dataset = item.metadata.datasetName ?? 'unknown';
      const kind = item.metadata.kind ?? 'unknown';
      const docType = item.metadata.document_type ?? 'unknown';
      byDataset[dataset] = (byDataset[dataset] ?? 0) + 1;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      byDocType[docType] = (byDocType[docType] ?? 0) + 1;
    }

    return {
      benchmark: {
        id: this.id,
        version: this.version,
        sourceRoot: files.length === 1 ? files[0] : path.dirname(files[0]),
        sourceFiles: files,
        sourcePaths: files,
        sourceCommit: null,
        promptVersion: this.promptVersion,
        materializationVersion: this.materializationVersion
      },
      inventory: {
        benchmark: this.id,
        sourceRoot: files.length === 1 ? files[0] : path.dirname(files[0]),
        records: cases.map((item) => ({
          id: item.caseId,
          benchmark: item.benchmarkId,
          status: 'selected',
          selected: true,
          skipReasons: []
        })),
        summary: {
          total: cases.length,
          selected: cases.length,
          available_skipped: Math.max(allCases.length - cases.length, 0),
          unsupported: 0,
          skipReasons: {},
          byDataset,
          byKind,
          byDocType
        }
      },
      cases
    };
  }
};
