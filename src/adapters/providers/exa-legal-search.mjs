/**
 * exa-legal-search — legal case-law retrieval via Exa's /search API.
 *
 * Purpose-built for the "search-backend-only" Tier 0 benchmark: same
 * dataset, same scorer envelope as openai-legal-search / anthropic-legal-
 * search / courtlistener-search, so results are directly comparable in a
 * single scores.json. No LLM in the loop — this measures Exa's raw
 * retrieval quality against a legal-domain benchmark.
 *
 * Key behaviors that separate this from the older `exa-web-search`:
 *
 *  1. Per-row `includeDomains` derived from the row's `authority_identifier`
 *     via the shipped court coverage sheet (src/data/court-url-map.mjs).
 *     `domain_scope` config knob picks primary-only, primary+aggregators,
 *     or unrestricted.
 *
 *  2. Query is drawn from the benchmark row via `query_mode`:
 *       - "question" (default): row.prompt = natural-language question
 *       - "title":              row.metadata.document_title + canonical
 *                               citation — fair "can Exa find this specific
 *                               case if we ask directly?" sanity check.
 *
 *  3. Citation extraction from returned URLs (per-host URL parsers) and
 *     excerpts (regex + primary-vs-reference context classifier). Only
 *     STRONG hits (URL cross-ref against gold cl_cluster_id, or caption-
 *     class citation in excerpt) populate the scorer envelope's `citation`
 *     field. Reference-class matches surface in providerMetadata for
 *     analysis but do NOT count toward hitAt{k}.
 *
 *  4. `providerMetadata.extraction` records the per-result context class
 *     breakdown, unmatched hosts, and per-parser hit counts so the
 *     citation-audit tooling can iterate on URL parsers based on real run
 *     data.
 */

import { courtIdToHosts } from '../../data/court-url-map.mjs';
import { extractCitations } from '../../data/citation-extractor.mjs';

const DEFAULT_ENDPOINT = 'https://api.exa.ai/search';
const DEFAULT_API_KEY_ENV = 'EXA_API_KEY';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_TOP_K = 25;
const DEFAULT_SEARCH_TYPE = 'auto';
const DEFAULT_HIGHLIGHTS_PER_URL = 3;
const DEFAULT_HIGHLIGHT_SENTENCES = 3;
const MAX_ATTEMPTS = 2;
const PROVIDER_ID = 'exa-legal-search';
const PROVIDER_VERSION = 'exa-legal-search-provider-v1';

const CASE_MODEL_TYPES = new Set(['case_question', 'case_key_fact']);

// Aggregators to add when domain_scope === 'primary_plus_aggregators'.
// Deliberately excludes:
//   - Paid-access aggregators (vlex, casemine, casetext) — Exa shouldn't
//     be able to hit content customers wouldn't otherwise access.
//   - Cornell LII (law.cornell.edu) — their case-law snapshot is stale
//     enough that it introduces coverage noise rather than signal.
const DEFAULT_AGGREGATOR_HOSTS = [
  'courtlistener.com',
  'law.justia.com',
  'supreme.justia.com',
  'scholar.google.com',
  'openjurist.org',
  'caselaw.findlaw.com'
];

const VALID_QUERY_MODES = new Set(['question', 'title']);
const VALID_DOMAIN_SCOPES = new Set([
  'primary_only',
  'primary_plus_aggregators',
  'aggregators_only',
  'unrestricted'
]);

// -----------------------------------------------------------------------
// Small helpers (mirroring the openai-legal-search style)
// -----------------------------------------------------------------------

function positiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstString(...values) {
  for (const value of values.flat()) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function isAbortError(err) {
  if (!err) return false;
  const name = err.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return /operation was aborted|timed out|timeout/i.test(message);
}

function configuredQueryMode(config) {
  const mode = firstString(config.query_mode, config.queryMode) ?? 'question';
  if (!VALID_QUERY_MODES.has(mode)) {
    throw new Error(`exa-legal-search unknown query_mode='${mode}' (expected question | title)`);
  }
  return mode;
}

function configuredDomainScope(config) {
  const scope = firstString(config.domain_scope, config.domainScope) ?? 'primary_only';
  if (!VALID_DOMAIN_SCOPES.has(scope)) {
    throw new Error(
      `exa-legal-search unknown domain_scope='${scope}' (expected primary_only | primary_plus_aggregators | aggregators_only | unrestricted)`
    );
  }
  return scope;
}

function configuredTopK(config) {
  return positiveInteger(config.top_k ?? config.topK ?? config.limit, DEFAULT_TOP_K);
}

function configuredAggregators(config) {
  const raw = config.aggregator_hosts ?? config.aggregatorHosts;
  if (raw === undefined) return DEFAULT_AGGREGATOR_HOSTS.slice();
  return normalizeList(raw);
}

function assertCaseRow(benchmarkCase) {
  const metadata = benchmarkCase?.metadata ?? {};
  const docType = metadata.doc_type ?? metadata.docType;
  const modelType = metadata.model_type ?? metadata.modelType;
  if (docType !== 'case' || !CASE_MODEL_TYPES.has(modelType)) {
    throw new Error(
      `exa-legal-search only supports case rows; got doc_type=${docType ?? 'unknown'} ` +
        `model_type=${modelType ?? 'unknown'}`
    );
  }
}

// -----------------------------------------------------------------------
// Query + include_domains construction (per row)
// -----------------------------------------------------------------------

export function buildQueryForRow(benchmarkCase, config) {
  const mode = configuredQueryMode(config);
  const metadata = benchmarkCase?.metadata ?? {};
  if (mode === 'title') {
    const title = firstString(metadata.document_title, metadata.documentTitle);
    const canonical = firstString(metadata.expected?.canonical_citation);
    if (!title && !canonical) {
      throw new Error('exa-legal-search query_mode=title requires document_title or canonical_citation');
    }
    return [title, canonical].filter(Boolean).join(' ').trim();
  }
  const query = benchmarkCase?.prompt ?? metadata.query_text ?? metadata.queryText;
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('exa-legal-search requires a non-empty case prompt');
  }
  return query.trim();
}

export function buildIncludeDomainsForRow(benchmarkCase, config) {
  const scope = configuredDomainScope(config);
  if (scope === 'unrestricted') return [];
  // aggregators_only ignores per-row court scoping entirely — every row sends
  // the same aggregator host list. Skips the court-url-map lookup so it's
  // safe to run without any CSV configured.
  if (scope === 'aggregators_only') return configuredAggregators(config);
  const metadata = benchmarkCase?.metadata ?? {};
  const authority = firstString(metadata.authority_identifier, metadata.authorityIdentifier, metadata.court_id, metadata.courtId);
  const primaryHosts = authority ? courtIdToHosts(authority) : [];
  if (scope === 'primary_only') return primaryHosts;
  // primary_plus_aggregators
  const aggregators = configuredAggregators(config);
  const combined = new Set([...primaryHosts, ...aggregators]);
  return Array.from(combined);
}

// -----------------------------------------------------------------------
// Exa /search request body
// -----------------------------------------------------------------------

export function buildRequestBody(benchmarkCase, config = {}) {
  assertCaseRow(benchmarkCase);
  const query = buildQueryForRow(benchmarkCase, config);
  const topK = configuredTopK(config);
  const body = {
    query,
    type: firstString(config.search_type, config.searchType) ?? DEFAULT_SEARCH_TYPE,
    numResults: topK,
    contents: {
      highlights: {
        numSentences: positiveInteger(config.highlight_sentences ?? config.highlightSentences, DEFAULT_HIGHLIGHT_SENTENCES),
        highlightsPerUrl: positiveInteger(config.highlights_per_url ?? config.highlightsPerUrl, DEFAULT_HIGHLIGHTS_PER_URL)
      }
    }
  };
  const includeDomains = buildIncludeDomainsForRow(benchmarkCase, config);
  if (includeDomains.length) body.includeDomains = includeDomains;
  const excludeDomains = normalizeList(config.exclude_domains ?? config.excludeDomains);
  if (excludeDomains.length) body.excludeDomains = excludeDomains;
  return body;
}

// -----------------------------------------------------------------------
// Envelope normalization + citation extraction
// -----------------------------------------------------------------------

function resultText(exaResult) {
  const parts = [
    exaResult.title,
    exaResult.text,
    exaResult.snippet,
    ...(Array.isArray(exaResult.highlights) ? exaResult.highlights : [])
  ].filter((s) => typeof s === 'string' && s.trim());
  return parts.join('\n\n');
}

function publisherFromHost(host) {
  if (!host) return null;
  if (host === 'courtlistener.com' || host === 'www.courtlistener.com') return 'CourtListener';
  if (host === 'law.justia.com' || host === 'supreme.justia.com') return 'Justia';
  if (host === 'scholar.google.com') return 'Google Scholar';
  if (host === 'law.cornell.edu') return 'Cornell LII';
  if (host === 'openjurist.org') return 'OpenJurist';
  if (host === 'caselaw.findlaw.com') return 'FindLaw';
  if (host.endsWith('.gov')) return host;
  return host;
}

// Convert a single Exa result into the scorer envelope shape. Only STRONG
// hits (URL cross-ref against gold cl_cluster_id OR caption-class citation
// in excerpts) populate `citation`; loose (reference-only) hits do NOT
// contribute to hitAt{k}. Every match — strong or loose — is captured in
// providerMetadata for downstream analysis.
export function normalizeExaResult(exaResult, gold, index) {
  const url = exaResult.url || '';
  const text = resultText(exaResult);
  const evidence = extractCitations({ url, text, gold });
  const host = evidence.urlHit?.host ?? null;
  const strong = evidence.strongHit;
  // Populate `citation` only if we have a strong hit. Otherwise leave it
  // null so the scorer doesn't count reference-only matches.
  const citation = strong ? (gold?.canonical_citation ?? null) : null;
  // `citations[]` echoes every gold citation that appeared in text with
  // caption class; empty for reference-only or non-hit rows.
  const captionCitations = strong
    ? evidence.textMatches
        .filter((m) => m.contextClass === 'caption')
        .map((m) => m.citation)
    : [];
  return {
    rank: index + 1,
    title: exaResult.title ?? null,
    url,
    citation,
    citations: Array.from(new Set(captionCitations)),
    bluebook_citation: citation,
    publisher: publisherFromHost(host),
    date: exaResult.publishedDate ?? null,
    excerpt: (Array.isArray(exaResult.highlights) ? exaResult.highlights.join(' … ') : null) ??
      exaResult.snippet ?? null,
    summary: null,
    relevance: null,
    result_type: 'case',
    // Evidence block — not consumed by the scorer, but preserved for the
    // audit tooling and comparison README.
    _evidence: {
      strongHit: strong,
      looseHit: evidence.looseHit,
      urlMatchesGold: evidence.urlMatchesGold,
      urlParser: evidence.urlHit?.parser ?? null,
      host,
      contextBreakdown: evidence.contextBreakdown,
      textMatches: evidence.textMatches.map((m) => ({
        citation: m.citation,
        contextClass: m.contextClass,
        contextBefore: m.contextBefore,
        contextAfter: m.contextAfter
      }))
    }
  };
}

export function normalizeEnvelope(query, exaResults, gold, { topK = DEFAULT_TOP_K } = {}) {
  const results = (Array.isArray(exaResults) ? exaResults : [])
    .slice(0, topK)
    .map((r, i) => normalizeExaResult(r, gold, i));
  return {
    query,
    total_available: exaResults?.length ?? 0,
    result_count: results.length,
    results
  };
}

// -----------------------------------------------------------------------
// Provider metadata + extraction summary
// -----------------------------------------------------------------------

function summarizeExtraction(envelope) {
  const results = envelope.results ?? [];
  const strongHits = results.filter((r) => r._evidence?.strongHit);
  const looseHits = results.filter((r) => r._evidence?.looseHit);
  const byParser = {};
  const byHost = {};
  const unmatchedHosts = new Set();
  let contextCaption = 0;
  let contextReference = 0;
  let contextUnknown = 0;
  for (const r of results) {
    const ev = r._evidence ?? {};
    if (ev.host) byHost[ev.host] = (byHost[ev.host] || 0) + 1;
    const parser = ev.urlParser;
    if (parser) byParser[parser] = (byParser[parser] || 0) + 1;
    // parseUrl returns unmatched_host: true when no parser matched, and we
    // stored .host in that case. Detect unmatched by checking urlParser
    // absence on non-empty host.
    if (!parser && ev.host) unmatchedHosts.add(ev.host);
    contextCaption += ev.contextBreakdown?.caption ?? 0;
    contextReference += ev.contextBreakdown?.reference ?? 0;
    contextUnknown += ev.contextBreakdown?.unknown ?? 0;
  }
  return {
    strongHitCount: strongHits.length,
    looseHitCount: looseHits.length,
    firstStrongHitRank: strongHits.length ? strongHits[0].rank : null,
    firstLooseHitRank: looseHits.length ? looseHits[0].rank : null,
    contextClasses: {
      caption: contextCaption,
      reference: contextReference,
      unknown: contextUnknown
    },
    byParser,
    byHost,
    unmatchedHosts: Array.from(unmatchedHosts).sort()
  };
}

// -----------------------------------------------------------------------
// Failure helpers
// -----------------------------------------------------------------------

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = /x-api-key|authorization/i.test(name) ? '[REDACTED]' : value;
  }
  return out;
}

function makeFailure(benchmarkCase, kind, message, {
  endpoint = null,
  request = null,
  httpStatus = null,
  startedAtMs = Date.now(),
  completedAtMs = Date.now(),
  rawResponse = null
} = {}) {
  return {
    caseId: benchmarkCase.caseId,
    status: 'provider_failure',
    rawOutput: {
      endpoint,
      request,
      httpStatus,
      response: rawResponse,
      normalizedResults: [],
      error: { kind, message }
    },
    finalOutputText: JSON.stringify({
      query: benchmarkCase.prompt ?? '',
      total_available: 0,
      result_count: 0,
      results: []
    }),
    artifacts: [],
    providerMetadata: {
      provider: PROVIDER_ID,
      endpoint,
      httpStatus,
      error: kind,
      resultCount: 0
    },
    timing: {
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      serverResponseDurationMs: null
    },
    tokenUsage: null,
    retryMetadata: null,
    error: { kind, message, status: httpStatus }
  };
}

function httpErrorMessage(payload, responseText, httpStatus) {
  return (
    payload?.error?.message ??
    payload?.message ??
    (responseText ? responseText.slice(0, 500) : null) ??
    `HTTP ${httpStatus}`
  );
}

function isRetryableProviderFailure(result) {
  if (result?.status !== 'provider_failure') return false;
  return result.error?.kind === 'fetch_error';
}

// -----------------------------------------------------------------------
// Attempt loop
// -----------------------------------------------------------------------

async function executeAttempt({
  benchmarkCase,
  endpoint,
  request,
  headers,
  requestTimeoutMs,
  topK,
  fetchFn
}) {
  const startedAtMs = Date.now();
  let httpStatus = null;
  let responseJson = null;
  let responseText = null;
  let fetchError = null;
  let responseParseError = null;
  let timeoutError = null;

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    httpStatus = response.status;
    responseText = await response.text();
    try {
      responseJson = responseText ? JSON.parse(responseText) : null;
    } catch (caught) {
      responseParseError = caught instanceof Error ? caught.message : String(caught);
    }
  } catch (caught) {
    if (isAbortError(caught)) {
      timeoutError = caught instanceof Error ? caught.message : String(caught);
    } else {
      fetchError = caught instanceof Error ? caught.message : String(caught);
    }
  }

  const completedAtMs = Date.now();
  const redactedRequest = {
    method: 'POST',
    headers: redactHeaders(headers),
    body: request
  };

  if (timeoutError) {
    return makeFailure(
      benchmarkCase,
      'timeout',
      `exa-legal-search request exceeded ${requestTimeoutMs}ms: ${timeoutError}`,
      { endpoint, request: redactedRequest, httpStatus, startedAtMs, completedAtMs, rawResponse: responseJson }
    );
  }
  if (fetchError) {
    return makeFailure(benchmarkCase, 'fetch_error', fetchError, {
      endpoint, request: redactedRequest, httpStatus, startedAtMs, completedAtMs
    });
  }
  if (httpStatus < 200 || httpStatus > 299) {
    return makeFailure(
      benchmarkCase,
      'http_error',
      httpErrorMessage(responseJson, responseText, httpStatus),
      { endpoint, request: redactedRequest, httpStatus, startedAtMs, completedAtMs, rawResponse: responseJson ?? responseText }
    );
  }
  if (responseParseError) {
    return makeFailure(
      benchmarkCase,
      'parse_error',
      `Failed to parse Exa response JSON: ${responseParseError}`,
      { endpoint, request: redactedRequest, httpStatus, startedAtMs, completedAtMs, rawResponse: responseText }
    );
  }
  if (!responseJson || !Array.isArray(responseJson.results) || responseJson.results.length === 0) {
    return makeFailure(
      benchmarkCase,
      'missing_results',
      'Exa returned no results for this query + include_domains',
      { endpoint, request: redactedRequest, httpStatus, startedAtMs, completedAtMs, rawResponse: responseJson }
    );
  }

  const gold = benchmarkCase.metadata?.expected ?? {};
  const envelope = normalizeEnvelope(request.query, responseJson.results, gold, { topK });
  const extraction = summarizeExtraction(envelope);

  return {
    caseId: benchmarkCase.caseId,
    status: 'completed',
    rawOutput: {
      endpoint,
      request: redactedRequest,
      httpStatus,
      response: responseJson,
      normalizedResults: envelope.results,
      searchId: responseJson.searchId ?? responseJson.search_id ?? null
    },
    finalOutputText: JSON.stringify(envelope),
    artifacts: [],
    providerMetadata: {
      provider: PROVIDER_ID,
      endpoint,
      httpStatus,
      queryMode: request._queryMode,
      domainScope: request._domainScope,
      includeDomains: request.includeDomains ?? [],
      searchType: request.type,
      topK,
      resultCount: envelope.result_count,
      totalAvailable: envelope.total_available,
      extraction
    },
    timing: {
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      serverResponseDurationMs: null
    },
    tokenUsage: null,
    retryMetadata: null,
    error: null
  };
}

function attemptSummary(result, attempt) {
  return {
    attempt,
    status: result.status,
    error: result.error ?? null,
    httpStatus: result.providerMetadata?.httpStatus ?? null,
    durationMs: result.timing?.durationMs ?? null,
    startedAt: result.timing?.startedAt ?? null,
    completedAt: result.timing?.completedAt ?? null
  };
}

function withRetryMetadata(result, attempts) {
  if (attempts.length <= 1) return result;
  const startedAt = attempts[0].startedAt ?? result.timing?.startedAt ?? null;
  const completedAt = result.timing?.completedAt ?? null;
  const durationMs =
    startedAt && completedAt
      ? Date.parse(completedAt) - Date.parse(startedAt)
      : result.timing?.durationMs ?? null;
  return {
    ...result,
    providerMetadata: {
      ...result.providerMetadata,
      attempts: attempts.length,
      retryCount: attempts.length - 1
    },
    timing: {
      ...result.timing,
      startedAt,
      durationMs,
      firstAttemptStartedAt: startedAt,
      finalAttemptStartedAt: result.timing?.startedAt ?? null
    },
    retryMetadata: {
      maxAttempts: MAX_ATTEMPTS,
      attempts,
      retryCount: attempts.length - 1
    }
  };
}

// -----------------------------------------------------------------------
// Public adapter
// -----------------------------------------------------------------------

export const exaLegalSearchProviderAdapter = {
  id: PROVIDER_ID,
  version: PROVIDER_VERSION,

  async describe({ config = {} }) {
    return {
      id: this.id,
      version: this.version,
      subject: 'case-law-search',
      target: config.endpoint ?? DEFAULT_ENDPOINT,
      apiKeyEnv: config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      settings: {
        queryMode: (() => { try { return configuredQueryMode(config); } catch { return null; } })(),
        domainScope: (() => { try { return configuredDomainScope(config); } catch { return null; } })(),
        aggregatorHosts: configuredDomainScope(config) === 'primary_plus_aggregators' ? configuredAggregators(config) : [],
        topK: configuredTopK(config),
        requestTimeoutMs: config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
        searchType: firstString(config.search_type, config.searchType) ?? DEFAULT_SEARCH_TYPE,
        supportedModelTypes: [...CASE_MODEL_TYPES]
      }
    };
  },

  async executeCase({ benchmarkCase, config = {} }) {
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    let request;
    try {
      request = buildRequestBody(benchmarkCase, config);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const kind =
        message.includes('only supports case rows') ? 'validation_error'
          : message.includes('unknown query_mode') || message.includes('unknown domain_scope') ? 'config_error'
            : 'validation_error';
      return makeFailure(benchmarkCase, kind, message, { endpoint });
    }

    const apiKeyEnv = config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      return makeFailure(benchmarkCase, 'config_error', `Missing env ${apiKeyEnv}`, { endpoint, request });
    }

    // Tag the outgoing request with the resolved config knobs so the manifest
    // captures them (not sent to Exa — stripped before serialization).
    request._queryMode = configuredQueryMode(config);
    request._domainScope = configuredDomainScope(config);
    const wireBody = { ...request };
    delete wireBody._queryMode;
    delete wireBody._domainScope;

    const headers = {
      'x-api-key': apiKey,
      'content-type': 'application/json'
    };
    const requestTimeoutMs = config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const topK = configuredTopK(config);
    const fetchFn = config._fetch ?? globalThis.fetch;

    const attempts = [];
    let result = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      result = await executeAttempt({
        benchmarkCase,
        endpoint,
        request: wireBody,
        headers,
        requestTimeoutMs,
        topK,
        fetchFn
      });
      // Preserve the resolved config on the result's providerMetadata for
      // reproducibility even though it was stripped from the wire body.
      if (result.providerMetadata && !result.providerMetadata.error) {
        result.providerMetadata.queryMode = request._queryMode;
        result.providerMetadata.domainScope = request._domainScope;
      }
      attempts.push(attemptSummary(result, attempt));
      if (!isRetryableProviderFailure(result)) break;
    }
    return withRetryMetadata(result, attempts);
  }
};

export const _internals = {
  DEFAULT_AGGREGATOR_HOSTS,
  assertCaseRow,
  buildIncludeDomainsForRow,
  buildQueryForRow,
  buildRequestBody,
  configuredAggregators,
  configuredDomainScope,
  configuredQueryMode,
  configuredTopK,
  isRetryableProviderFailure,
  makeFailure,
  normalizeExaResult,
  normalizeEnvelope,
  publisherFromHost,
  resultText,
  summarizeExtraction
};
