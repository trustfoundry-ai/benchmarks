import {
  acceptedCitationSet,
  normalizeCitation,
  splitCitationList
} from '../../core/citations.mjs';

const VERSION = 'search-recall-v1';
const CUTOFFS = [1, 5, 10, 25];
const HEADLINE_CUTOFF = 25;
const MRR_DECIMAL_PLACES = 4;

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resultCitations(result) {
  const values = [
    result?.citation,
    result?.citations,
    result?.primary_citation ?? result?.primaryCitation,
    result?.all_citations ?? result?.allCitations,
    result?.bluebook_citation ?? result?.bluebookCitation,
    result?.neutral_cite ?? result?.neutralCite,
    result?.lexis_cite ?? result?.lexisCite
  ];
  const seen = new Set();
  return values
    .flatMap((value) => splitCitationList(value))
    .filter((citation) => {
      const normalized = normalizeCitation(citation);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function resultDocumentIds(result) {
  return [
    result?.doc_id,
    result?.document_uuid,
    result?.documentUuid,
    result?.case_id,
    result?.caseId
  ].filter(Boolean).map(String);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? '')
  );
}

function firstHitRank(envelope, expected, expectedDocumentUuid = null) {
  const accepted = acceptedCitationSet(expected);
  if (!accepted.size && !expectedDocumentUuid) return null;
  const results = Array.isArray(envelope?.results) ? envelope.results : [];
  for (const [index, result] of results.entries()) {
    const citations = resultCitations(result);
    const matchesCitation = citations.some((citation) => accepted.has(normalizeCitation(citation)));
    const matchesDocument = expectedDocumentUuid
      ? resultDocumentIds(result).includes(expectedDocumentUuid)
      : false;
    if (matchesCitation || matchesDocument) {
      return Number.isInteger(result.rank) && result.rank > 0 ? result.rank : index + 1;
    }
  }
  return null;
}

function goldQuality(expected, expectedDocumentUuid = null) {
  const hasCitationGold = acceptedCitationSet(expected).size > 0;
  const hasDocumentGold = Boolean(expectedDocumentUuid);
  const malformedGold = hasDocumentGold && !isUuid(expectedDocumentUuid);
  const emptyGold = !hasCitationGold && !hasDocumentGold;
  return {
    emptyGold,
    malformedGold,
    validGold: hasCitationGold || (hasDocumentGold && !malformedGold)
  };
}

function latencyMs(providerResult) {
  const duration = providerResult?.timing?.durationMs;
  return Number.isFinite(duration) ? duration : null;
}

function truncateDecimal(value, decimalPlaces) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimalPlaces;
  return Math.trunc(value * factor) / factor;
}

function scoreCase({ benchmarkCase, providerResult }) {
  const expected = benchmarkCase.metadata?.expected ?? null;
  const expectedDocumentUuid = benchmarkCase.metadata?.document_uuid ?? null;
  const { emptyGold, malformedGold, validGold } = goldQuality(expected, expectedDocumentUuid);
  const matchDocumentUuid = malformedGold ? null : expectedDocumentUuid;
  const base = {
    caseId: benchmarkCase.caseId,
    rowIndex: benchmarkCase.metadata?.datasetIndex ?? null,
    split: benchmarkCase.split ?? null,
    docType: benchmarkCase.metadata?.doc_type ?? null,
    field: benchmarkCase.metadata?.field ?? null,
    modelType: benchmarkCase.metadata?.model_type ?? null,
    datasetName: benchmarkCase.metadata?.datasetName ?? null,
    state: benchmarkCase.metadata?.state ?? benchmarkCase.metadata?.geo_level_2_identifier ?? null,
    expected,
    expectedDocumentUuid,
    emptyGold,
    malformedGold,
    validGold,
    providerStatus: providerResult?.status ?? 'missing'
  };

  if (!providerResult || providerResult.status !== 'completed') {
    return {
      ...base,
      status: 'provider_failure',
      score: 0,
      hitRank: null,
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      hitAt25: false,
      reciprocalRank: 0,
      resultCount: 0,
      latencyMs: latencyMs(providerResult),
      error: providerResult?.error ?? null
    };
  }

  const envelope = safeParse(providerResult.finalOutputText) ?? {};
  const hitRank = firstHitRank(envelope, expected, matchDocumentUuid);
  const resultCount = Array.isArray(envelope.results) ? envelope.results.length : 0;
  return {
    ...base,
    status: 'scored',
    score: hitRank !== null && hitRank <= HEADLINE_CUTOFF ? 1 : 0,
    hitRank,
    hitAt1: hitRank !== null && hitRank <= 1,
    hitAt5: hitRank !== null && hitRank <= 5,
    hitAt10: hitRank !== null && hitRank <= 10,
    hitAt25: hitRank !== null && hitRank <= 25,
    reciprocalRank: hitRank ? 1 / hitRank : 0,
    resultCount,
    latencyMs: latencyMs(providerResult),
    error: null
  };
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * (pct / 100);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function aggregate(caseScores) {
  const n = caseScores.length;
  const hitAt = {};
  for (const cutoff of CUTOFFS) {
    hitAt[`hit@${cutoff}`] = n
      ? caseScores.filter((item) => item.hitRank !== null && item.hitRank <= cutoff).length / n
      : 0;
  }
  return {
    n,
    hit_at: hitAt,
    mrr: n
      ? truncateDecimal(
          caseScores.reduce((sum, item) => sum + item.reciprocalRank, 0) / n,
          MRR_DECIMAL_PLACES
        )
      : 0
  };
}

function legacyAggregate(caseScores) {
  const validSuccess = caseScores.filter((item) => item.status === 'scored' && item.validGold);
  const overall = aggregate(validSuccess);
  const providerFailures = caseScores.filter((item) => item.status !== 'scored').length;
  const summary = {
    total: caseScores.length,
    scored: validSuccess.length,
    providerFailures,
    hitAt1: overall.hit_at['hit@1'],
    hitAt5: overall.hit_at['hit@5'],
    hitAt10: overall.hit_at['hit@10'],
    hitAt25: overall.hit_at['hit@25'],
    mrr: overall.mrr,
    meanResultCount: mean(validSuccess.map((item) => item.resultCount))
  };
  summary.overallScore = summary.hitAt25;
  summary.supportedScore = summary.hitAt25;
  return summary;
}

function qualityCounts(caseScores) {
  const total = caseScores.length;
  const failed = caseScores.filter((item) => item.status !== 'scored').length;
  const validGold = caseScores.filter((item) => item.validGold).length;
  const validSuccess = caseScores.filter((item) => item.validGold && item.status === 'scored').length;
  return {
    n_total: total,
    n_success: total - failed,
    n_failed: failed,
    failure_rate: total ? failed / total : 0,
    n_valid_gold: validGold,
    n_valid_success: validSuccess,
    n_empty_gold: caseScores.filter((item) => item.emptyGold).length,
    n_malformed_gold: caseScores.filter((item) => item.malformedGold).length
  };
}

function latencySummary(caseScores) {
  const values = caseScores
    .map((item) => item.latencyMs)
    .filter((value) => Number.isFinite(value));
  if (!values.length) return { n: 0, min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  return {
    n: values.length,
    min: Math.min(...values),
    mean: mean(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values)
  };
}

function groupRaw(caseScores, key) {
  const groups = {};
  for (const item of caseScores) {
    const value = item[key] || '<unknown>';
    groups[value] ??= [];
    groups[value].push(item);
  }
  return groups;
}

function aggregateByState(caseScores) {
  const out = {};
  for (const [state, bucket] of Object.entries(groupRaw(caseScores, 'state'))) {
    out[state] = aggregate(bucket);
  }
  return out;
}

function grouped(caseScores, key) {
  const out = {};
  for (const [value, bucket] of Object.entries(groupRaw(caseScores, key))) {
    out[value] = legacyAggregate(bucket);
  }
  return out;
}

function buildSummary(caseScores, { manifest = null } = {}) {
  const validSuccess = caseScores.filter((item) => item.status === 'scored' && item.validGold);
  const strict = caseScores.filter((item) => item.validGold);
  return {
    ...legacyAggregate(caseScores),
    execution: {
      runId: manifest?.runId ?? manifest?.run_id ?? null,
      benchmark: manifest?.benchmark ?? null,
      provider: manifest?.provider ?? null,
      scheduler: manifest?.scheduler ?? null,
      scorer: {
        id: 'search-recall',
        version: VERSION,
        cutoffs: CUTOFFS,
        headlineCutoff: HEADLINE_CUTOFF,
        mrrDecimalPlaces: MRR_DECIMAL_PLACES
      },
      caseCount: caseScores.length
    },
    quality: qualityCounts(caseScores),
    latency_ms: latencySummary(caseScores),
    overall: aggregate(validSuccess),
    strict_overall: aggregate(strict),
    per_state: aggregateByState(validSuccess),
    strict_per_state: aggregateByState(strict),
    bySplit: grouped(caseScores, 'split'),
    byDataset: grouped(caseScores, 'datasetName'),
    byDocType: grouped(caseScores, 'docType'),
    byField: grouped(caseScores, 'field'),
    byModelType: grouped(caseScores, 'modelType'),
    byState: grouped(caseScores, 'state')
  };
}

export const searchRecallScorerAdapter = {
  id: 'search-recall',
  version: VERSION,

  async describe() {
    return {
      id: this.id,
      version: this.version,
      notes: 'Deterministic public search recall scoring using expected document UUIDs or citations.'
    };
  },

  async score({ manifest, cases, providerResults }) {
    const byCaseId = new Map(providerResults.map((result) => [result.caseId, result]));
    const caseScores = cases.map((benchmarkCase) =>
      scoreCase({ benchmarkCase, providerResult: byCaseId.get(benchmarkCase.caseId) })
    );
    return {
      scorerId: this.id,
      status: 'completed',
      caseScores,
      summary: buildSummary(caseScores, { manifest }),
      metadata: {
        scorer: this.id,
        version: this.version,
        cutoffs: CUTOFFS,
        mrrDecimalPlaces: MRR_DECIMAL_PLACES
      }
    };
  }
};

export const _internals = {
  resultCitations,
  resultDocumentIds,
  firstHitRank,
  goldQuality,
  scoreCase,
  aggregate,
  truncateDecimal,
  qualityCounts,
  latencySummary,
  buildSummary
};
