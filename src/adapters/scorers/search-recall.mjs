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

// Some search backends return a top-level `cluster_id` on each result — a
// stable native identifier for the underlying document cluster. We match it
// against `expected.cl_cluster_id` when the dataset supplies one. Providers
// that don't populate `cluster_id` on results return [] here, so the check
// is a no-op for them.
function resultClusterIds(result) {
  return [
    result?.cluster_id,
    result?.clusterId
  ].filter((value) => value !== undefined && value !== null && value !== '').map(String);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? '')
  );
}

// Match order at each ranked position: native IDs (document_uuid, then
// cl_cluster_id) first, then citation-string matching as a fallback. Order
// does not affect the hit@K math (first ranked result with any signal wins),
// but the code intent is explicit — native IDs are exact and immune to
// citation-normalization drift.
function firstHitRank(envelope, expected, expectedDocumentUuid = null, expectedClusterId = null) {
  const accepted = acceptedCitationSet(expected);
  if (!accepted.size && !expectedDocumentUuid && !expectedClusterId) return null;
  const results = Array.isArray(envelope?.results) ? envelope.results : [];
  for (const [index, result] of results.entries()) {
    const matchesDocument = expectedDocumentUuid
      ? resultDocumentIds(result).includes(expectedDocumentUuid)
      : false;
    const matchesCluster = expectedClusterId
      ? resultClusterIds(result).includes(String(expectedClusterId))
      : false;
    let matchesCitation = false;
    if (!matchesDocument && !matchesCluster) {
      const citations = resultCitations(result);
      matchesCitation = citations.some((citation) => accepted.has(normalizeCitation(citation)));
    }
    if (matchesDocument || matchesCluster || matchesCitation) {
      return Number.isInteger(result.rank) && result.rank > 0 ? result.rank : index + 1;
    }
  }
  return null;
}

function goldQuality(expected, expectedDocumentUuid = null, expectedClusterId = null) {
  const hasCitationGold = acceptedCitationSet(expected).size > 0;
  const hasDocumentGold = Boolean(expectedDocumentUuid);
  const hasClusterGold = Boolean(expectedClusterId);
  const malformedGold = hasDocumentGold && !isUuid(expectedDocumentUuid);
  const emptyGold = !hasCitationGold && !hasDocumentGold && !hasClusterGold;
  return {
    emptyGold,
    malformedGold,
    validGold: hasCitationGold || hasClusterGold || (hasDocumentGold && !malformedGold)
  };
}

function latencyMs(providerResult) {
  const duration = providerResult?.timing?.durationMs;
  return Number.isFinite(duration) ? duration : null;
}

function serverResponseDurationMs(providerResult) {
  const duration = providerResult?.timing?.serverResponseDurationMs;
  return Number.isFinite(duration) ? duration : null;
}

function numericTokenField(tokenUsage, ...keys) {
  for (const key of keys) {
    const value = tokenUsage?.[key] ?? tokenUsage?.raw?.[key];
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function tokenUsage(providerResult) {
  const usage = providerResult?.tokenUsage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = numericTokenField(usage, 'inputTokens', 'input_tokens');
  const outputTokens = numericTokenField(usage, 'outputTokens', 'output_tokens');
  const cacheCreationInputTokens = numericTokenField(
    usage,
    'cacheCreationInputTokens',
    'cache_creation_input_tokens'
  );
  const cacheReadInputTokens = numericTokenField(
    usage,
    'cacheReadInputTokens',
    'cache_read_input_tokens'
  );
  const totalTokens =
    numericTokenField(usage, 'totalTokens', 'total_tokens') ||
    inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens
  };
}

function truncateDecimal(value, decimalPlaces) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimalPlaces;
  return Math.trunc(value * factor) / factor;
}

function scoreCase({ benchmarkCase, providerResult }) {
  const expected = benchmarkCase.metadata?.expected ?? null;
  const expectedDocumentUuid = benchmarkCase.metadata?.document_uuid ?? null;
  const expectedClusterId = expected?.cl_cluster_id ?? null;
  const { emptyGold, malformedGold, validGold } = goldQuality(
    expected,
    expectedDocumentUuid,
    expectedClusterId
  );
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
    expectedClusterId,
    emptyGold,
    malformedGold,
    validGold,
    providerStatus: providerResult?.status ?? 'missing'
  };
  const usage = tokenUsage(providerResult);
  if (usage) base.tokenUsage = usage;

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
      serverResponseDurationMs: serverResponseDurationMs(providerResult),
      error: providerResult?.error ?? null
    };
  }

  const envelope = safeParse(providerResult.finalOutputText) ?? {};
  const hitRank = firstHitRank(envelope, expected, matchDocumentUuid, expectedClusterId);
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
    serverResponseDurationMs: serverResponseDurationMs(providerResult),
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

function latencySummary(caseScores, field = 'latencyMs') {
  const values = caseScores
    .map((item) => item[field])
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

function tokenUsageSummary(caseScores) {
  const values = caseScores
    .map((item) => item.tokenUsage)
    .filter((usage) => usage && typeof usage === 'object');
  if (!values.length) return null;
  const sum = (key) => values.reduce((total, usage) => total + (usage[key] ?? 0), 0);
  return {
    n: values.length,
    input_tokens: sum('inputTokens'),
    output_tokens: sum('outputTokens'),
    cache_creation_input_tokens: sum('cacheCreationInputTokens'),
    cache_read_input_tokens: sum('cacheReadInputTokens'),
    total_tokens: sum('totalTokens')
  };
}

function numericPricingField(pricing, ...keys) {
  for (const key of keys) {
    const value = pricing?.[key];
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function roundCost(value) {
  return Number.isFinite(value) ? Number(value.toFixed(8)) : null;
}

function pricingSnapshotFromManifest(manifest) {
  const pricing = manifest?.provider?.settings?.pricing ?? manifest?.provider?.pricing ?? null;
  if (!pricing || typeof pricing !== 'object') return null;
  const inputPerMillion = numericPricingField(
    pricing,
    'input_per_million_tokens',
    'inputPerMillionTokens'
  );
  const outputPerMillion = numericPricingField(
    pricing,
    'output_per_million_tokens',
    'outputPerMillionTokens'
  );
  if (inputPerMillion === null && outputPerMillion === null) return null;
  return {
    model: pricing.model ?? manifest?.provider?.settings?.model ?? null,
    pricing_level: pricing.pricing_level ?? pricing.pricingLevel ?? null,
    source: pricing.source ?? null,
    source_accessed_at: pricing.source_accessed_at ?? pricing.sourceAccessedAt ?? null,
    currency: pricing.currency ?? 'USD',
    unit: pricing.unit ?? 'per_1m_tokens',
    input_per_million_tokens: inputPerMillion,
    output_per_million_tokens: outputPerMillion
  };
}

function tokenCostSummary(tokenSummary, { manifest = null } = {}) {
  if (!tokenSummary) return null;
  const pricing = pricingSnapshotFromManifest(manifest);
  if (!pricing) return null;
  const inputCost =
    pricing.input_per_million_tokens === null
      ? null
      : (tokenSummary.input_tokens / 1_000_000) * pricing.input_per_million_tokens;
  const outputCost =
    pricing.output_per_million_tokens === null
      ? null
      : (tokenSummary.output_tokens / 1_000_000) * pricing.output_per_million_tokens;
  const totalCost = [inputCost, outputCost]
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
  return {
    currency: pricing.currency,
    model: pricing.model,
    pricing_level: pricing.pricing_level,
    source: pricing.source,
    source_accessed_at: pricing.source_accessed_at,
    unit: pricing.unit,
    input_per_million_tokens: pricing.input_per_million_tokens,
    output_per_million_tokens: pricing.output_per_million_tokens,
    input_cost: roundCost(inputCost),
    output_cost: roundCost(outputCost),
    total_cost: roundCost(totalCost)
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
  const successfulScores = caseScores.filter((item) => item.status === 'scored');
  const failedScores = caseScores.filter((item) => item.status !== 'scored');
  const summary = {
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
    latency_ms: latencySummary(successfulScores),
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
  if (failedScores.some((item) => Number.isFinite(item.latencyMs))) {
    summary.provider_failure_latency_ms = latencySummary(failedScores);
  }
  if (caseScores.some((item) => Number.isFinite(item.serverResponseDurationMs))) {
    summary.server_response_duration_ms = latencySummary(
      successfulScores,
      'serverResponseDurationMs'
    );
  }
  const tokens = tokenUsageSummary(caseScores);
  if (tokens) {
    summary.token_usage = tokens;
    const cost = tokenCostSummary(tokens, { manifest });
    if (cost) summary.token_cost = cost;
  }
  return summary;
}

export const searchRecallScorerAdapter = {
  id: 'search-recall',
  version: VERSION,
  SUPPORTED_CUTOFFS: CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF: HEADLINE_CUTOFF,

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
    return finalize({ manifest, caseScores, scorerId: this.id, version: this.version });
  },

  // Streaming variant. `pairs` is an async iterable yielding either
  // `{ benchmarkCase, providerResult }` objects or `[benchmarkCase, providerResult]`
  // tuples. Each pair is scored as it arrives; only the per-case score (small,
  // bounded) is retained. The optional `onCaseScored({ benchmarkCase, providerResult, caseScore })`
  // hook lets the caller pipe each scored case to disk (e.g. into a raw.jsonl
  // writer) without a second pass over the inputs.
  async scoreStream({ manifest, pairs, onCaseScored }) {
    const caseScores = [];
    for await (const pair of pairs) {
      const benchmarkCase = pair.benchmarkCase ?? pair[0];
      const providerResult = pair.providerResult ?? pair[1];
      const caseScore = scoreCase({ benchmarkCase, providerResult });
      caseScores.push(caseScore);
      if (onCaseScored) {
        await onCaseScored({ benchmarkCase, providerResult, caseScore });
      }
    }
    return finalize({ manifest, caseScores, scorerId: this.id, version: this.version });
  }
};

function finalize({ manifest, caseScores, scorerId, version }) {
  return {
    scorerId,
    status: 'completed',
    caseScores,
    summary: buildSummary(caseScores, { manifest }),
    metadata: {
      scorer: scorerId,
      version,
      cutoffs: CUTOFFS,
      mrrDecimalPlaces: MRR_DECIMAL_PLACES
    }
  };
}

// Exposed for runner-side config validation. If you change CUTOFFS or
// HEADLINE_CUTOFF above, update configs/scorers/search-recall.json to match -
// the runner refuses to start when these diverge.
export const SUPPORTED_CUTOFFS = CUTOFFS;
export const SUPPORTED_HEADLINE_CUTOFF = HEADLINE_CUTOFF;

export const _internals = {
  resultCitations,
  resultDocumentIds,
  resultClusterIds,
  firstHitRank,
  goldQuality,
  scoreCase,
  aggregate,
  truncateDecimal,
  qualityCounts,
  latencySummary,
  tokenUsage,
  tokenUsageSummary,
  tokenCostSummary,
  pricingSnapshotFromManifest,
  buildSummary
};
