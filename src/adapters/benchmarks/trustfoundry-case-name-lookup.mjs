import path from 'node:path';
import { stat } from 'node:fs/promises';

import { readJsonl } from '../../core/fs.mjs';

const BENCHMARK_ID = 'trustfoundry-case-name-lookup';
const VERSION = 'trustfoundry-case-name-lookup-v1';
const MATERIALIZATION_VERSION = 'trustfoundry-case-name-lookup-data-v1';

// model_type is 'case_name', the dedicated case-name lookup lane. The search
// API accepts it as a first-class model type distinct from a general semantic
// case retriever being asked to do case-name lookup; using a general
// retriever type here would understate this lane's accuracy.
//
// Do NOT change this to citation_search. It is tuned for citation strings, and
// its validator exempts it from "state is required for non-citation searches",
// which would silently discard the jurisdiction filter this whole suite depends
// on. `case_name` stays subject to that requirement, so every row here must
// carry a resolvable state.
const MODEL_TYPE = 'case_name';

function upperState(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length ? trimmed : null;
}

// The gold CSV renders a database NULL as an empty string, so a federal row's
// expected.geo_level_2_identifier is '' rather than absent. The harness
// provider resolves state via
// `metadata.geo_level_2_identifier ?? expected.state ?? metadata.state`
// (trustfoundry-legal-search.mjs's stateForCase) -- `??` is nullish
// coalescing, which falls through on null/undefined but NOT on ''. Collapse
// both absent and empty-string to null here so the chain falls through to
// metadata.state (which stateForRow already resolves to the correct 'FED')
// for federal rows. A genuine state value (e.g. 'fl') passes through
// untouched -- do not upcase or otherwise normalize it here, only the
// emptiness check.
function normalizedGeoLevel2(value) {
  if (typeof value !== 'string') return null;
  return value === '' ? null : value;
}

// Mirrors trustfoundry-legal-search.mjs's stateForRow/jurisdictionIdForRow
// (the harness's jurisdiction model) exactly in spirit, adapted for the
// fact that our rows nest every state-bearing field under `expected`
// rather than at the row's top level, and that doc_type is implicitly
// always 'case' for this suite (there is no doc_type field on the row --
// trustfoundry-case-name-lookup only ever looks up cases).
function stateForRow(expected) {
  const configuredState = upperState(expected.state);
  if (configuredState) return configuredState;
  const geo2 = upperState(expected.geo_level_2_identifier);
  if (geo2) return geo2;
  // geo_level_1_identifier is always the literal 'us' for this suite and
  // is never itself a jurisdiction -- it must not be consulted here.
  return 'FED';
}

function jurisdictionIdForRow(expected) {
  const state = stateForRow(expected);
  return state === 'FED' ? 'us' : state.toLowerCase();
}

function flattenGoldAnswers(goldCitations) {
  const values = [];
  for (const entry of Array.isArray(goldCitations) ? goldCitations : []) {
    if (entry?.canonical_citation) values.push(entry.canonical_citation);
    for (const alternate of Array.isArray(entry?.alternates) ? entry.alternates : []) {
      if (alternate) values.push(alternate);
    }
  }
  return Array.from(new Set(values));
}

function buildCase(row, { index, datasetLabel }) {
  const expected = row.expected ?? {};
  const kind = expected.kind ?? 'positive';
  const tier = expected.tier ?? datasetLabel;
  const nameTransform = expected.name_transform ?? null;
  const state = stateForRow(expected);
  const jurisdictionId = jurisdictionIdForRow(expected);
  const allowedAnswers = flattenGoldAnswers(expected.gold_citations);
  // First gold canonical, or null for a negative row -- a negative row has
  // no gold citation at all, so there is nothing a provider could correctly
  // return as *the* answer.
  const expectedAnswer = kind === 'positive' ? (allowedAnswers[0] ?? null) : null;

  return {
    caseId: row.caseId,
    benchmarkId: BENCHMARK_ID,
    taskId: `${tier}:${nameTransform ?? 'clean'}`,
    split: 'test',
    // The perturbed name the provider must search for -- NEVER
    // expected.case_name (the clean name). Reading the wrong field here
    // hands the provider an empty/irrelevant query and produces a 0.0
    // baseline indistinguishable from a genuine capability gap.
    prompt: row.query_text ?? '',
    expectedAnswer,
    allowedAnswers,
    metadata: {
      datasetLabel,
      datasetIndex: index,
      case_name: expected.case_name ?? null,
      authority_identifier: expected.authority_identifier ?? null,
      // Derived from authority_identifier, not the reverse.
      court_id: expected.authority_identifier ?? null,
      court_name: expected.court_name ?? null,
      year_filed: expected.year_filed ?? null,
      geo_level_1_identifier: expected.geo_level_1_identifier ?? null,
      // Emitted at the metadata top level (not only nested under
      // `expected` below) because the provider's stateForCase looks at
      // metadata.geo_level_2_identifier first, falling back to
      // metadata.state only if that is absent. Emit both so neither path
      // depends on the other.
      geo_level_2_identifier: normalizedGeoLevel2(expected.geo_level_2_identifier),
      state,
      jurisdiction_id: jurisdictionId,
      datasource_id: expected.datasource_id ?? null,
      citation_form: expected.citation_form ?? null,
      doc_type: 'case',
      model_type: MODEL_TYPE,
      tier,
      name_transform: nameTransform,
      corpus_cluster_size: expected.corpus_cluster_size ?? null,
      jurisdiction_cluster_size: expected.jurisdiction_cluster_size ?? null,
      negative_category: expected.negative_category ?? null,
      expected: { ...expected }
    },
    scoringHints: {
      kind: 'trustfoundry-case-name-lookup',
      outputMode: 'json',
      negative: kind === 'negative'
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
      "trustfoundry-case-name-lookup benchmark config requires 'datasetPath' (or 'dataDir' + 'files')"
    );
  }
  const abs = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  const stats = await stat(abs).catch((error) => {
    throw new Error(`trustfoundry-case-name-lookup dataset not found at ${abs}: ${error.message}`);
  });
  if (!stats.isFile()) {
    throw new Error(`trustfoundry-case-name-lookup datasetPath is not a file: ${abs}`);
  }
  return abs;
}

/**
 * Select whole pairs from each category, walking a category's pairs with a
 * fixed stride from a fixed offset. Striding rather than taking a contiguous
 * block: both are unbiased in expectation, but a contiguous block inherits one
 * block's luck while a strided sample averages across the file. Both arms of a
 * selected pair always travel together, because the paired-control comparison
 * is meaningless with one arm missing.
 *
 * A category that cannot supply `pairsPerCategory` pairs at this stride/offset
 * throws rather than silently returning fewer -- the suite's equal-allocation
 * checks exist to catch unequal per-category counts, and by the time they
 * catch it a run has already spent provider calls.
 */
function selectPairsPerCategory(allCases, { pairsPerCategory, stride, offset }) {
  const pairOrder = new Map();
  const byPair = new Map();
  for (const item of allCases) {
    const expected = item.metadata?.expected ?? {};
    const category = expected.name_transform ?? 'uncategorized';
    const pairId = expected.pair_id ?? item.caseId;
    if (!byPair.has(pairId)) {
      byPair.set(pairId, []);
      if (!pairOrder.has(category)) pairOrder.set(category, []);
      pairOrder.get(category).push(pairId);
    }
    byPair.get(pairId).push(item);
  }

  const selected = new Set();
  for (const [category, pairs] of pairOrder) {
    let taken = 0;
    let index = offset;
    for (; index < pairs.length && taken < pairsPerCategory; index += stride) {
      selected.add(pairs[index]);
      taken += 1;
    }
    if (taken < pairsPerCategory) {
      throw new Error(
        `trustfoundry-case-name-lookup: category '${category}' has ${pairs.length} pairs, ` +
          `which cannot supply pairsPerCategory=${pairsPerCategory} at stride=${stride} ` +
          `offset=${offset} -- only ${taken} pair(s) were reachable before the walk needed ` +
          `index ${index} (>= ${pairs.length}).`
      );
    }
  }
  return allCases.filter((item) =>
    selected.has(item.metadata?.expected?.pair_id ?? item.caseId)
  );
}

function summaryFor(cases) {
  const byTier = {};
  const byKind = {};
  const byNameTransform = {};
  for (const item of cases) {
    const tier = item.metadata.tier ?? 'unknown';
    const kind = item.metadata.expected?.kind ?? 'unknown';
    const nameTransform = item.metadata.name_transform ?? 'clean';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byNameTransform[nameTransform] = (byNameTransform[nameTransform] ?? 0) + 1;
  }
  return {
    total: cases.length,
    selected: cases.length,
    byTier,
    byKind,
    byNameTransform
  };
}

export const caseNameLookupBenchmarkAdapter = {
  id: BENCHMARK_ID,
  version: VERSION,

  // Fields that must survive into a published bundle's raw rows. The scorer's
  // hit rule is caption-based (see trustfoundry-case-name-lookup.mjs), so gold is the
  // caption itself (`case_name`) plus the category, arm, and jurisdiction the
  // per-category table and the jurisdiction guard are built from -- not a
  // citation set. Without these a re-score of a published bundle rebuilds
  // every row with no target caption and no category, and every metric reads
  // 0. This is an ALLOWLIST, not a wildcard: `metadata.expected` also carries
  // internal fields that must never reach a published row, so a field only
  // survives publication by being named here.
  publishedExpectedFields: [
    'case_name',
    'name_transform',
    'arm',
    'pair_id',
    'tier',
    'synthetic',
    'geo_level_2_identifier'
  ],
  materializationVersion: MATERIALIZATION_VERSION,

  async loadCases({ config, repoRoot }) {
    const datasetPath = await resolveDatasetPath(config, repoRoot);
    const datasetLabel =
      config.datasetLabel ?? config.dataset_label ?? path.basename(path.dirname(datasetPath));
    const rows = await readJsonl(datasetPath);
    const allCases = rows.map((row, index) => buildCase(row, { index, datasetLabel }));
    const offset = Number.isInteger(config.offset) && config.offset > 0 ? config.offset : 0;
    const limit = Number.isInteger(config.limit) ? config.limit : null;
    const pairsPerCategory = Number.isInteger(config.pairsPerCategory) ? config.pairsPerCategory : null;

    if (pairsPerCategory !== null && limit !== null) {
      throw new Error(
        'trustfoundry-case-name-lookup: pairsPerCategory and limit are mutually exclusive — ' +
          'limit slices the flat file, which is grouped by category, so it would return one ' +
          "category's pairs and nothing else."
      );
    }

    let cases;
    if (pairsPerCategory === null) {
      cases = limit === null ? allCases.slice(offset) : allCases.slice(offset, offset + limit);
    } else {
      cases = selectPairsPerCategory(allCases, {
        pairsPerCategory,
        stride: Number.isInteger(config.stride) && config.stride > 0 ? config.stride : 1,
        offset
      });
    }

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
  jurisdictionIdForRow,
  normalizedGeoLevel2,
  flattenGoldAnswers,
  resolveDatasetPath,
  summaryFor,
  selectPairsPerCategory
};
