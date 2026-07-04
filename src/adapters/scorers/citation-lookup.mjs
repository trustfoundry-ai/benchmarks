import {
  acceptedCitationSet,
  normalizeCitation,
  splitCitationList
} from '../../core/citations.mjs';

const SCORER_ID = 'citation-lookup';
const BENCHMARK_ID = 'citation-lookup';
const VERSION = 'citation-lookup-v1';
const DEFAULT_CUTOFFS = [1, 5, 10, 25];
const DEFAULT_HEADLINE_CUTOFF = 1;

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

function resultClusterId(result) {
  const value = result?.cluster_id ?? result?.clusterId;
  return value === undefined || value === null || value === '' ? null : String(value);
}

function rankFor(result, index) {
  return Number.isInteger(result?.rank) && result.rank > 0 ? result.rank : index + 1;
}

// Citation-first, cluster_id fallback. For each ranked result, try citation
// match against the accepted set; if none match, remember the first cluster_id
// hit as a fallback. If a citation matches earlier than any cluster_id, the
// citation wins the rank. Returns { rank, matchedBy } where matchedBy is
// 'citation', 'cluster_id', or null.
function firstHitRank(envelope, expected, expectedClusterId) {
  const results = Array.isArray(envelope?.results) ? envelope.results : [];
  const accepted = acceptedCitationSet(expected);
  const target = expectedClusterId != null ? String(expectedClusterId) : null;
  if (!accepted.size && !target) return { rank: null, matchedBy: null };
  let clusterIdHit = null;
  for (const [index, result] of results.entries()) {
    if (accepted.size) {
      const cites = resultCitations(result);
      if (cites.some((cite) => accepted.has(normalizeCitation(cite)))) {
        return { rank: rankFor(result, index), matchedBy: 'citation' };
      }
    }
    if (clusterIdHit === null && target) {
      const cid = resultClusterId(result);
      if (cid !== null && cid === target) {
        clusterIdHit = { rank: rankFor(result, index), matchedBy: 'cluster_id' };
      }
    }
  }
  return clusterIdHit ?? { rank: null, matchedBy: null };
}

function envelopeResultCount(envelope) {
  return Array.isArray(envelope?.results) ? envelope.results.length : 0;
}

// Vendor-neutral ambiguity signal on the envelope. Providers whose native
// response format includes an ambiguity indicator (e.g. a status code
// meaning "multiple candidates matched") should normalize it to
// `envelope.provider_ambiguous: true`. The scorer surfaces it per case
// and reports the population fraction as `ambiguous_rate` in the headline
// summary. Left null when no provider populates the flag.
function envelopeProviderAmbiguous(envelope) {
  const raw = envelope?.provider_ambiguous ?? envelope?.providerAmbiguous;
  if (raw === undefined || raw === null) return false;
  return Boolean(raw);
}

function isNegativeCase(expected) {
  return expected?.kind === 'negative';
}

function positiveGoldQuality(expected) {
  const emptyGold = acceptedCitationSet(expected).size === 0;
  return {
    emptyGold,
    malformedGold: false,
    validGold: !emptyGold
  };
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

function scoreCase({ benchmarkCase, providerResult, cutoffs, headlineCutoff }) {
  const expected = benchmarkCase.metadata?.expected ?? null;
  const expectedClusterId = expected?.cl_cluster_id ?? null;
  const negative = isNegativeCase(expected);

  const base = {
    caseId: benchmarkCase.caseId,
    rowIndex: benchmarkCase.metadata?.datasetIndex ?? null,
    datasetName: benchmarkCase.metadata?.datasetName ?? null,
    documentType: benchmarkCase.metadata?.document_type ?? null,
    difficulty: benchmarkCase.metadata?.difficulty ?? null,
    authority: benchmarkCase.metadata?.authority_identifier ?? null,
    datasource: benchmarkCase.metadata?.datasource_id ?? null,
    geo: benchmarkCase.metadata?.geo_level_2 ?? 'FED',
    kind: benchmarkCase.metadata?.kind ?? null,
    negativeCategory: benchmarkCase.metadata?.negative_category ?? null,
    expected,
    expectedClusterId,
    providerStatus: providerResult?.status ?? 'missing'
  };

  if (!providerResult || providerResult.status !== 'completed') {
    return {
      ...base,
      status: 'provider_failure',
      hitRank: null,
      matchedBy: null,
      ...hitAtFields(null, cutoffs),
      score: 0,
      reciprocalRank: 0,
      resultCount: 0,
      providerAmbiguous: false,
      negative,
      negativeCorrect: null,
      falsePositive: null,
      emptyGold: false,
      malformedGold: false,
      validGold: false,
      latencyMs: latencyMs(providerResult),
      error: providerResult?.error ?? null
    };
  }

  const envelope = safeParse(providerResult.finalOutputText) ?? {};
  const resultCount = envelopeResultCount(envelope);
  const providerAmbiguous = envelopeProviderAmbiguous(envelope);

  if (negative) {
    const negativeCorrect = resultCount === 0;
    return {
      ...base,
      status: 'scored',
      hitRank: null,
      matchedBy: null,
      ...hitAtFields(null, cutoffs),
      score: negativeCorrect ? 1 : 0,
      reciprocalRank: 0,
      resultCount,
      providerAmbiguous,
      negative: true,
      negativeCorrect,
      falsePositive: !negativeCorrect,
      emptyGold: false,
      malformedGold: false,
      validGold: true,
      latencyMs: latencyMs(providerResult),
      error: null
    };
  }

  const { emptyGold, malformedGold, validGold } = positiveGoldQuality(expected);
  const hit = firstHitRank(envelope, expected, expectedClusterId);
  const hitRank = hit.rank;
  const matchedBy = hit.matchedBy;
  const headlineHit = hitRank !== null && hitRank <= headlineCutoff;

  return {
    ...base,
    status: 'scored',
    hitRank,
    matchedBy,
    ...hitAtFields(hitRank, cutoffs),
    score: headlineHit ? 1 : 0,
    reciprocalRank: hitRank ? 1 / hitRank : 0,
    resultCount,
    providerAmbiguous,
    negative: false,
    negativeCorrect: null,
    falsePositive: null,
    emptyGold,
    malformedGold,
    validGold,
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

function latencySummary(caseScores) {
  const values = caseScores
    .map((item) => item.latencyMs)
    .filter((value) => Number.isFinite(value));
  if (!values.length) {
    return { n: 0, min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  }
  return {
    n: values.length,
    min: Math.min(...values),
    mean: mean(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values)
  };
}

function aggregatePositives(caseScores, cutoffs) {
  const scored = caseScores.filter(
    (item) => item.status === 'scored' && !item.negative && item.validGold
  );
  const n = scored.length;
  const hitAt = {};
  for (const cutoff of cutoffs) {
    hitAt[cutoff] = n
      ? scored.filter((item) => item.hitRank !== null && item.hitRank <= cutoff).length / n
      : 0;
  }
  const mrr = n ? scored.reduce((sum, item) => sum + item.reciprocalRank, 0) / n : 0;
  const hitAtOne = hitAt[1] ?? 0;
  const hitAtFive = hitAt[5] ?? 0;
  return {
    n,
    hit_at: Object.fromEntries(cutoffs.map((cutoff) => [`hit@${cutoff}`, hitAt[cutoff]])),
    mrr,
    ambiguous_match_rate: hitAtFive - hitAtOne
  };
}

function negativeSummary(caseScores) {
  const negatives = caseScores.filter((item) => item.status === 'scored' && item.negative);
  const n = negatives.length;
  const falsePositives = negatives.filter((item) => item.falsePositive).length;
  return {
    n,
    fp_rate: n ? falsePositives / n : 0,
    correct: n - falsePositives
  };
}

// Fraction of positive hits earned via native cluster_id rather than by
// citation match. Denominator: positive scored cases with a valid gold
// citation, a non-null `expected.cl_cluster_id`, and hitRank !== null.
// Returns null when the denominator is zero (e.g. runs whose providers
// never expose a cluster_id on results). A high value signals that the
// provider's citation formats diverge from the accepted set — most hits
// are recovered only by the fallback path.
function clusterIdFallbackRate(caseScores) {
  const eligible = caseScores.filter(
    (item) =>
      item.status === 'scored' &&
      !item.negative &&
      item.validGold &&
      item.expectedClusterId !== null &&
      item.expectedClusterId !== undefined &&
      item.hitRank !== null
  );
  if (!eligible.length) return null;
  const fallback = eligible.filter((item) => item.matchedBy === 'cluster_id').length;
  return fallback / eligible.length;
}

// Fraction of scored positive cases where the provider flagged the response
// as ambiguous. Null when no such cases exist, so consumers can distinguish
// "provider never reports ambiguity" from "provider reports 0% ambiguous".
function ambiguousRate(caseScores) {
  const positives = caseScores.filter(
    (item) => item.status === 'scored' && !item.negative && item.validGold
  );
  if (!positives.length) return null;
  const ambiguous = positives.filter((item) => item.providerAmbiguous).length;
  return ambiguous / positives.length;
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
    n_malformed_gold: caseScores.filter((item) => item.malformedGold).length,
    n_negatives: caseScores.filter((item) => item.negative).length,
    n_positives: caseScores.filter((item) => !item.negative && item.status === 'scored').length
  };
}

function groupBy(caseScores, key) {
  const groups = new Map();
  for (const item of caseScores) {
    const value = item[key] ?? 'unknown';
    const bucket = groups.get(value) ?? [];
    bucket.push(item);
    groups.set(value, bucket);
  }
  return groups;
}

function stratify(caseScores, key, cutoffs, { includeNegatives = false } = {}) {
  const groups = groupBy(caseScores, key);
  const out = {};
  for (const [value, bucket] of groups.entries()) {
    if (!includeNegatives && bucket.every((item) => item.negative)) continue;
    const positives = aggregatePositives(bucket, cutoffs);
    const negatives = negativeSummary(bucket);
    out[value] = {
      total: bucket.length,
      positives,
      negatives: negatives.n ? negatives : null
    };
  }
  return out;
}

function stratifyNegatives(caseScores, key) {
  const negatives = caseScores.filter((item) => item.status === 'scored' && item.negative);
  const groups = groupBy(negatives, key);
  const out = {};
  for (const [value, bucket] of groups.entries()) {
    out[value] = negativeSummary(bucket);
  }
  return out;
}

function publicUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value);
  }
}

function buildExecutionSummary({ manifest, caseScores, cutoffs, headlineCutoff }) {
  return {
    runId: manifest?.runId ?? manifest?.run_id ?? null,
    generatedAt: new Date().toISOString(),
    benchmark: {
      id: manifest?.benchmark?.id ?? null,
      version: manifest?.benchmark?.version ?? null,
      configPath: manifest?.benchmark?.configPath ?? null,
      sourceRoot: manifest?.benchmark?.sourceRoot ?? null,
      datasetNames: Array.from(new Set(caseScores.map((item) => item.datasetName).filter(Boolean))).sort()
    },
    provider: {
      id: manifest?.provider?.id ?? null,
      version: manifest?.provider?.version ?? null,
      target: publicUrl(manifest?.provider?.target),
      apiKeyEnv: manifest?.provider?.apiKeyEnv ?? null,
      settings: manifest?.provider?.settings ?? null,
      configPath: manifest?.provider?.configPath ?? null
    },
    scorer: {
      id: manifest?.scorer?.id ?? SCORER_ID,
      version: manifest?.scorer?.version ?? VERSION,
      configPath: manifest?.scorer?.configPath ?? null,
      cutoffs,
      headline_cutoff: headlineCutoff
    },
    caseCount: caseScores.length
  };
}

function buildSummary(caseScores, { manifest = null, cutoffs, headlineCutoff } = {}) {
  const positives = aggregatePositives(caseScores, cutoffs);
  const negatives = negativeSummary(caseScores);
  const overallScore = positives.hit_at[`hit@${headlineCutoff}`] ?? 0;
  return {
    headline: {
      hit_at_1: positives.hit_at['hit@1'],
      hit_at_5: positives.hit_at['hit@5'],
      hit_at_10: positives.hit_at['hit@10'],
      hit_at_25: positives.hit_at['hit@25'],
      mrr: positives.mrr,
      ambiguous_match_rate: positives.ambiguous_match_rate,
      fp_rate: negatives.n ? negatives.fp_rate : null,
      ambiguous_rate: ambiguousRate(caseScores),
      cluster_id_fallback_rate: clusterIdFallbackRate(caseScores)
    },
    overallScore,
    supportedScore: overallScore,
    execution: buildExecutionSummary({ manifest, caseScores, cutoffs, headlineCutoff }),
    quality: qualityCounts(caseScores),
    latency_ms: latencySummary(caseScores),
    positives,
    negatives: negatives.n ? negatives : null,
    byDocumentType: stratify(caseScores, 'documentType', cutoffs, { includeNegatives: true }),
    byDifficulty: stratify(caseScores, 'difficulty', cutoffs),
    byAuthority: stratify(caseScores, 'authority', cutoffs),
    byDatasource: stratify(caseScores, 'datasource', cutoffs),
    byGeo: stratify(caseScores, 'geo', cutoffs),
    byNegativeCategory: stratifyNegatives(caseScores, 'negativeCategory')
  };
}

function finalize({ manifest, caseScores, scorerId, version, cutoffs, headlineCutoff }) {
  return {
    scorerId,
    status: 'completed',
    caseScores,
    summary: buildSummary(caseScores, { manifest, cutoffs, headlineCutoff }),
    metadata: {
      scorer: scorerId,
      version,
      cutoffs,
      headline_cutoff: headlineCutoff
    }
  };
}

// Resolve cutoffs from (in order): direct `config` arg, `manifest.scorer.settings`,
// `manifest.scorer.config`, then defaults. Same layered lookup as search-recall.
function resolveSettings({ manifest, config } = {}) {
  const source =
    config ??
    manifest?.scorer?.settings ??
    manifest?.scorer?.config ??
    {};
  const rawCutoffs = source?.cutoffs;
  const cutoffs = Array.isArray(rawCutoffs) && rawCutoffs.length > 0
    ? Array.from(new Set(rawCutoffs.map(Number).filter((n) => Number.isFinite(n) && n > 0)))
        .sort((a, b) => a - b)
    : DEFAULT_CUTOFFS;
  const rawHeadline = source?.headline_cutoff ?? source?.headlineCutoff;
  const headlineParsed = Number.parseInt(String(rawHeadline ?? ''), 10);
  const headlineCutoff = Number.isFinite(headlineParsed) && headlineParsed > 0
    ? headlineParsed
    : DEFAULT_HEADLINE_CUTOFF;
  return { cutoffs, headlineCutoff };
}

export const citationLookupScorerAdapter = {
  id: SCORER_ID,
  version: VERSION,
  SUPPORTED_CUTOFFS: DEFAULT_CUTOFFS,
  SUPPORTED_HEADLINE_CUTOFF: DEFAULT_HEADLINE_CUTOFF,

  async describe() {
    return {
      id: this.id,
      version: this.version,
      notes:
        'Citation-lookup recall scoring. Positives are hit@K on the ranked results; ' +
        'matches are sought by normalized citation string first, then by native ' +
        'cluster_id on results that expose one. Reports headline hit@1, plus ' +
        'hit@5/10/25, MRR, ambiguous_match_rate (hit@5 − hit@1), fp_rate on ' +
        'negatives (non-empty response is a false positive), ambiguous_rate ' +
        '(fraction of scored positives whose provider flagged provider_ambiguous), ' +
        'and cluster_id_fallback_rate (fraction of positive hits earned via ' +
        'cluster_id rather than citation match).'
    };
  },

  async score({ manifest, cases, providerResults, config }) {
    const { cutoffs, headlineCutoff } = resolveSettings({ manifest, config });
    const byCaseId = new Map(providerResults.map((result) => [result.caseId, result]));
    const caseScores = cases
      .filter((item) => item.benchmarkId === BENCHMARK_ID)
      .map((benchmarkCase) =>
        scoreCase({
          benchmarkCase,
          providerResult: byCaseId.get(benchmarkCase.caseId),
          cutoffs,
          headlineCutoff
        })
      );
    return finalize({
      manifest,
      caseScores,
      scorerId: this.id,
      version: this.version,
      cutoffs,
      headlineCutoff
    });
  },

  // Streaming variant. Matches the shape used by search-recall — the runner
  // and artifacts pipeline both prefer this over score() so per-case rows
  // don't have to be materialized twice in memory. Only cases whose
  // benchmarkId matches this scorer are consumed; others are skipped
  // silently so multi-benchmark harnesses can share a raw-row stream.
  async scoreStream({ manifest, pairs, onCaseScored, config }) {
    const { cutoffs, headlineCutoff } = resolveSettings({ manifest, config });
    const caseScores = [];
    for await (const pair of pairs) {
      const benchmarkCase = pair.benchmarkCase ?? pair[0];
      const providerResult = pair.providerResult ?? pair[1];
      if (benchmarkCase?.benchmarkId !== BENCHMARK_ID) continue;
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
    return finalize({
      manifest,
      caseScores,
      scorerId: this.id,
      version: this.version,
      cutoffs,
      headlineCutoff
    });
  }
};

export const SUPPORTED_CUTOFFS = DEFAULT_CUTOFFS;
export const SUPPORTED_HEADLINE_CUTOFF = DEFAULT_HEADLINE_CUTOFF;
export const DEFAULT_CITATION_LOOKUP_CUTOFFS = DEFAULT_CUTOFFS;
export const DEFAULT_CITATION_LOOKUP_HEADLINE_CUTOFF = DEFAULT_HEADLINE_CUTOFF;

export const _internals = {
  scoreCase,
  firstHitRank,
  aggregatePositives,
  negativeSummary,
  ambiguousRate,
  clusterIdFallbackRate,
  buildSummary,
  resolveSettings,
  DEFAULT_CUTOFFS,
  DEFAULT_HEADLINE_CUTOFF,
  CUTOFFS: DEFAULT_CUTOFFS,
  HEADLINE_CUTOFF: DEFAULT_HEADLINE_CUTOFF
};
