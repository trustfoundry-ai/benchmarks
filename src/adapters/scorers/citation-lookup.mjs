import {
  acceptedCitationSet,
  normalizeCitation,
  splitCitationList
} from '../../core/citations.mjs';
import { validateScorerCutoffsMatchImplementation } from '../../core/scorer-validators.mjs';

const SCORER_ID = 'citation-lookup';
const VERSION = 'citation-lookup-v1';
const DEFAULT_CUTOFFS = [1, 5];
const DEFAULT_HEADLINE_CUTOFF = 1;
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
  const values = [result?.citation, result?.citations];
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
  return [result?.document_uuid, result?.documentUuid, result?.doc_id, result?.uuid]
    .filter(Boolean)
    .map(String);
}

function resultClusterIds(result) {
  return [result?.cluster_id, result?.clusterId]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String);
}

function envelopeResults(envelope) {
  if (!envelope) return [];
  if (Array.isArray(envelope.results)) return envelope.results;
  if (Array.isArray(envelope.search_results)) return envelope.search_results;
  return [];
}

function envelopeAmbiguous(envelope) {
  return Boolean(envelope?.provider_ambiguous) || envelope?.status === 300;
}

function firstHitRank(envelope, expected) {
  const accepted = acceptedCitationSet(expected);
  const expectedDocUuid = expected?.document_uuid ?? null;
  const expectedClusterId = expected?.cl_cluster_id ?? null;
  if (!accepted.size && !expectedDocUuid && !expectedClusterId) return null;
  const results = envelopeResults(envelope);
  for (const [index, result] of results.entries()) {
    const matchesDoc = expectedDocUuid
      ? resultDocumentIds(result).includes(String(expectedDocUuid))
      : false;
    const matchesCluster = expectedClusterId
      ? resultClusterIds(result).includes(String(expectedClusterId))
      : false;
    let matchesCitation = false;
    if (!matchesDoc && !matchesCluster && accepted.size) {
      const citations = resultCitations(result);
      matchesCitation = citations.some((c) => accepted.has(normalizeCitation(c)));
    }
    if (matchesDoc || matchesCluster || matchesCitation) {
      return Number.isInteger(result.rank) && result.rank > 0 ? result.rank : index + 1;
    }
  }
  return null;
}

function latencyMs(providerResult) {
  const duration = providerResult?.timing?.durationMs;
  return Number.isFinite(duration) ? duration : null;
}

function hitAtFields(hitRank, cutoffs) {
  const out = {};
  for (const k of cutoffs) {
    out[`hitAt${k}`] = hitRank !== null && hitRank <= k;
  }
  return out;
}

function isNegativeCase(benchmarkCase) {
  return benchmarkCase.metadata?.expected?.kind === 'negative';
}

function scoreCase({ benchmarkCase, providerResult, cutoffs, headlineCutoff }) {
  const expected = benchmarkCase.metadata?.expected ?? null;
  const negative = isNegativeCase(benchmarkCase);
  const base = {
    caseId: benchmarkCase.caseId,
    rowIndex: benchmarkCase.metadata?.datasetIndex ?? null,
    docType: benchmarkCase.metadata?.doc_type ?? null,
    difficulty: benchmarkCase.metadata?.difficulty ?? null,
    datasource: benchmarkCase.metadata?.datasource_id ?? null,
    state: benchmarkCase.metadata?.state ?? null,
    negativeCategory: benchmarkCase.metadata?.negative_category ?? null,
    modelType: benchmarkCase.metadata?.model_type ?? null,
    expected,
    negative,
    providerStatus: providerResult?.status ?? 'missing',
    providerAmbiguous: false
  };

  if (!providerResult || providerResult.status !== 'completed') {
    return {
      ...base,
      status: 'provider_failure',
      score: 0,
      hitRank: null,
      ...hitAtFields(null, cutoffs),
      reciprocalRank: 0,
      resultCount: 0,
      falsePositive: false,
      latencyMs: latencyMs(providerResult),
      error: providerResult?.error ?? null
    };
  }

  const envelope = safeParse(providerResult.finalOutputText) ?? {};
  const ambiguous = envelopeAmbiguous(envelope);
  const results = envelopeResults(envelope);
  const resultCount = results.length;

  if (negative) {
    const isEmpty = resultCount === 0;
    return {
      ...base,
      status: 'scored',
      score: isEmpty ? 1 : 0,
      hitRank: null,
      ...hitAtFields(null, cutoffs),
      reciprocalRank: 0,
      resultCount,
      falsePositive: !isEmpty,
      providerAmbiguous: ambiguous,
      latencyMs: latencyMs(providerResult),
      error: null
    };
  }

  const hitRank = firstHitRank(envelope, expected);
  return {
    ...base,
    status: 'scored',
    score: hitRank !== null && hitRank <= headlineCutoff ? 1 : 0,
    hitRank,
    ...hitAtFields(hitRank, cutoffs),
    reciprocalRank: hitRank ? 1 / hitRank : 0,
    resultCount,
    falsePositive: false,
    providerAmbiguous: ambiguous,
    latencyMs: latencyMs(providerResult),
    error: null
  };
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
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

function truncateDecimal(value, decimalPlaces) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimalPlaces;
  return Math.trunc(value * factor) / factor;
}

function aggregatePositives(cases, cutoffs) {
  const n = cases.length;
  const hitAt = {};
  for (const cutoff of cutoffs) {
    hitAt[`hit@${cutoff}`] = n
      ? cases.filter((c) => c.hitRank !== null && c.hitRank <= cutoff).length / n
      : 0;
  }
  const ambiguousCount = cases.filter((c) => c.providerAmbiguous).length;
  return {
    n,
    hit_at: hitAt,
    mrr: n
      ? truncateDecimal(
          cases.reduce((sum, c) => sum + c.reciprocalRank, 0) / n,
          MRR_DECIMAL_PLACES
        )
      : 0,
    ambiguousRate: n ? truncateDecimal(ambiguousCount / n, MRR_DECIMAL_PLACES) : 0
  };
}

function aggregateNegatives(cases) {
  const n = cases.length;
  const fp = cases.filter((c) => c.falsePositive).length;
  return {
    n,
    fp_rate: n ? truncateDecimal(fp / n, MRR_DECIMAL_PLACES) : 0,
    correct_empty: n - fp
  };
}

function groupBy(cases, key) {
  const groups = {};
  for (const c of cases) {
    const value = c[key] ?? '<unknown>';
    (groups[value] ??= []).push(c);
  }
  return groups;
}

function stratified(cases, key, aggregator, ...args) {
  const out = {};
  for (const [value, bucket] of Object.entries(groupBy(cases, key))) {
    out[value] = aggregator(bucket, ...args);
  }
  return out;
}

function latencySummary(cases) {
  const values = cases.map((c) => c.latencyMs).filter((v) => Number.isFinite(v));
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

function buildSummary(caseScores, { manifest, cutoffs, headlineCutoff }) {
  const scored = caseScores.filter((c) => c.status === 'scored');
  const positives = scored.filter((c) => !c.negative);
  const negatives = scored.filter((c) => c.negative);
  const failed = caseScores.filter((c) => c.status !== 'scored');

  const overall = aggregatePositives(positives, cutoffs);
  const headlineScore = overall.hit_at[`hit@${headlineCutoff}`] ?? 0;

  const total = caseScores.length;
  const summary = {
    total,
    scored: scored.length,
    positives: positives.length,
    negatives: negatives.length,
    providerFailures: failed.length,
    overallScore: headlineScore,
    supportedScore: headlineScore,
    mrr: overall.mrr,
    ambiguousRate: overall.ambiguousRate,
    execution: {
      runId: manifest?.runId ?? manifest?.run_id ?? null,
      benchmark: manifest?.benchmark ?? null,
      provider: manifest?.provider ?? null,
      scheduler: manifest?.scheduler ?? null,
      scorer: {
        id: SCORER_ID,
        version: VERSION,
        cutoffs,
        headlineCutoff,
        mrrDecimalPlaces: MRR_DECIMAL_PLACES
      },
      caseCount: total
    },
    overall,
    negatives_overall: aggregateNegatives(negatives),
    latency_ms: latencySummary(scored),
    byDocumentType: stratified(positives, 'docType', aggregatePositives, cutoffs),
    byDifficulty: stratified(positives, 'difficulty', aggregatePositives, cutoffs),
    byState: stratified(positives, 'state', aggregatePositives, cutoffs),
    byDatasource: stratified(positives, 'datasource', aggregatePositives, cutoffs),
    byNegativeCategory: stratified(negatives, 'negativeCategory', aggregateNegatives)
  };
  for (const k of cutoffs) {
    summary[`hitAt${k}`] = overall.hit_at[`hit@${k}`];
  }
  return summary;
}

function resolveSettings({ manifest, config } = {}) {
  const source = config ?? manifest?.scorer?.settings ?? manifest?.scorer?.config ?? {};
  const rawCutoffs = source?.cutoffs;
  const cutoffs = Array.isArray(rawCutoffs) && rawCutoffs.length > 0
    ? Array.from(new Set(rawCutoffs.map(Number).filter((n) => Number.isFinite(n) && n > 0)))
        .sort((a, b) => a - b)
    : DEFAULT_CUTOFFS;
  const rawHeadline = source?.headline_cutoff ?? source?.headlineCutoff;
  const parsed = Number.parseInt(String(rawHeadline ?? ''), 10);
  const headlineCutoff = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEADLINE_CUTOFF;
  return { cutoffs, headlineCutoff };
}

function finalize({ manifest, caseScores, cutoffs, headlineCutoff }) {
  return {
    scorerId: SCORER_ID,
    status: 'completed',
    caseScores,
    summary: buildSummary(caseScores, { manifest, cutoffs, headlineCutoff }),
    metadata: {
      scorer: SCORER_ID,
      version: VERSION,
      cutoffs,
      headlineCutoff,
      mrrDecimalPlaces: MRR_DECIMAL_PLACES
    }
  };
}

export const citationLookupScorerAdapter = {
  id: SCORER_ID,
  version: VERSION,
  SUPPORTED_CUTOFFS: DEFAULT_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF: DEFAULT_HEADLINE_CUTOFF,

  validateConfig({ scorerConfig }) {
    validateScorerCutoffsMatchImplementation(scorerConfig ?? {}, {
      supportedCutoffs: DEFAULT_CUTOFFS,
      supportedHeadlineCutoff: DEFAULT_HEADLINE_CUTOFF,
      scorerId: this.id
    });
  },

  async describe() {
    return {
      id: this.id,
      version: this.version,
      notes:
        'Citation-lookup recall scoring. Positives match by document_uuid, ' +
        'cl_cluster_id, or normalized citation string. Negatives (kind=negative) ' +
        'are correct iff the provider returns zero results. Emits ambiguousRate ' +
        '(fraction of positives with status=300 / provider_ambiguous=true).'
    };
  },

  async score({ manifest, cases, providerResults, config }) {
    const { cutoffs, headlineCutoff } = resolveSettings({ manifest, config });
    const byCaseId = new Map(providerResults.map((r) => [r.caseId, r]));
    const caseScores = cases.map((c) =>
      scoreCase({
        benchmarkCase: c,
        providerResult: byCaseId.get(c.caseId),
        cutoffs,
        headlineCutoff
      })
    );
    return finalize({ manifest, caseScores, cutoffs, headlineCutoff });
  },

  async scoreStream({ manifest, pairs, onCaseScored, config }) {
    const { cutoffs, headlineCutoff } = resolveSettings({ manifest, config });
    const caseScores = [];
    for await (const pair of pairs) {
      const benchmarkCase = pair.benchmarkCase ?? pair[0];
      const providerResult = pair.providerResult ?? pair[1];
      const caseScore = scoreCase({
        benchmarkCase,
        providerResult,
        cutoffs,
        headlineCutoff
      });
      caseScores.push(caseScore);
      if (onCaseScored) {
        await onCaseScored({ benchmarkCase, providerResult, caseScore });
      }
    }
    return finalize({ manifest, caseScores, cutoffs, headlineCutoff });
  }
};

export const SUPPORTED_CUTOFFS = DEFAULT_CUTOFFS;
export const SUPPORTED_HEADLINE_CUTOFF = DEFAULT_HEADLINE_CUTOFF;

export const _internals = {
  scoreCase,
  firstHitRank,
  envelopeResults,
  envelopeAmbiguous,
  resultCitations,
  resultDocumentIds,
  resultClusterIds,
  aggregatePositives,
  aggregateNegatives,
  buildSummary,
  resolveSettings
};
