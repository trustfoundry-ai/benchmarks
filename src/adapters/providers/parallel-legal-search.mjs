/**
 * parallel-legal-search — legal case-law retrieval via Parallel's /v1/search API.
 *
 * Purpose-built for the "search-backend-only" Tier 0 benchmark: same
 * dataset, same scorer envelope as openai-legal-search / anthropic-legal-
 * search / courtlistener-search / exa-legal-search, so results are
 * directly comparable in a single scores.json. No LLM in the loop — this
 * measures Parallel's raw retrieval quality against a legal-domain
 * benchmark.
 *
 * Modeled on exa-legal-search: URL + excerpt retrieval, per-host citation
 * parsing, strong-vs-loose evidence classification. The Parallel API
 * differs from Exa in the request shape:
 *
 *  - Request body nests filters under `advanced_settings`:
 *      { objective?, search_queries: [query], mode?, advanced_settings: {
 *          source_policy: { include_domains?, exclude_domains? },
 *          max_results?
 *      } }
 *  - Response results carry `excerpts: string[]` (multiple markdown
 *    snippets per result). The adapter joins them for the citation
 *    extractor.
 *  - Parallel does not return a total-hits count; the envelope's
 *    `total_available` is set to the returned `results.length`.
 *
 * The `domain_scope` / `query_mode` knobs mirror exa-legal-search so
 * evaluators can run apples-to-apples comparisons across search vendors.
 */

import { courtIdToHosts } from '../../data/court-url-map.mjs';
import { extractCitations } from '../../data/citation-extractor.mjs';

const DEFAULT_ENDPOINT = 'https://api.parallel.ai/v1/search';
const DEFAULT_API_KEY_ENV = 'PARALLEL_API_KEY';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_TOP_K = 25;
const DEFAULT_MODE = 'advanced';
const DEFAULT_OBJECTIVE = 'Retrieve U.S. case law opinions relevant to the search query.';
const MAX_ATTEMPTS = 2;
const PROVIDER_ID = 'parallel-legal-search';
const PROVIDER_VERSION = 'parallel-legal-search-provider-v1';

const CASE_MODEL_TYPES = new Set(['case_question', 'case_key_fact']);

// Aggregators to add when domain_scope === 'primary_plus_aggregators'.
// Same rationale as exa-legal-search — see docs/adapters/exa-legal-search.md
// for the on/off-list justification. Kept in sync deliberately so the two
// adapters are directly comparable in aggregators_only mode.
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
const VALID_MODES = new Set(['turbo', 'basic', 'advanced']);

// -----------------------------------------------------------------------
// Small helpers (mirroring exa-legal-search)
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
    throw new Error(`parallel-legal-search unknown query_mode='${mode}' (expected question | title)`);
  }
  return mode;
}

function configuredDomainScope(config) {
  const scope = firstString(config.domain_scope, config.domainScope) ?? 'primary_only';
  if (!VALID_DOMAIN_SCOPES.has(scope)) {
    throw new Error(
      `parallel-legal-search unknown domain_scope='${scope}' (expected primary_only | primary_plus_aggregators | aggregators_only | unrestricted)`
    );
  }
  return scope;
}

function configuredSearchMode(config) {
  const mode = firstString(config.search_mode, config.searchMode, config.mode) ?? DEFAULT_MODE;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`parallel-legal-search unknown mode='${mode}' (expected turbo | basic | advanced)`);
  }
  return mode;
}

function configuredTopK(config) {
  return positiveInteger(config.top_k ?? config.topK ?? config.limit, DEFAULT_TOP_K);
}

function configuredAggregators(config) {
  const raw = config.aggregator_hosts ?? config.aggregatorHosts;
  if (raw === undefined) return DEFAULT_AGGREGATOR_HOSTS.slice();
  return normalizeList(raw);
}

function configuredObjective(config) {
  if (Object.hasOwn(config, 'objective')) {
    const raw = config.objective;
    if (raw === null || raw === '') return null;
    return typeof raw === 'string' ? raw.trim() : null;
  }
  return DEFAULT_OBJECTIVE;
}

function assertCaseRow(benchmarkCase) {
  const metadata = benchmarkCase?.metadata ?? {};
  const docType = metadata.doc_type ?? metadata.docType;
  const modelType = metadata.model_type ?? metadata.modelType;
  if (docType !== 'case' || !CASE_MODEL_TYPES.has(modelType)) {
    throw new Error(
      `parallel-legal-search only supports case rows; got doc_type=${docType ?? 'unknown'} ` +
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
      throw new Error('parallel-legal-search query_mode=title requires document_title or canonical_citation');
    }
    return [title, canonical].filter(Boolean).join(' ').trim();
  }
  const query = benchmarkCase?.prompt ?? metadata.query_text ?? metadata.queryText;
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('parallel-legal-search requires a non-empty case prompt');
  }
  return query.trim();
}

export function buildIncludeDomainsForRow(benchmarkCase, config) {
  const scope = configuredDomainScope(config);
  if (scope === 'unrestricted') return [];
  if (scope === 'aggregators_only') return configuredAggregators(config);
  const metadata = benchmarkCase?.metadata ?? {};
  const authority = firstString(metadata.authority_identifier, metadata.authorityIdentifier, metadata.court_id, metadata.courtId);
  const primaryHosts = authority ? courtIdToHosts(authority) : [];
  if (scope === 'primary_only') return primaryHosts;
  const aggregators = configuredAggregators(config);
  const combined = new Set([...primaryHosts, ...aggregators]);
  return Array.from(combined);
}

// -----------------------------------------------------------------------
// Parallel /v1/search request body
// -----------------------------------------------------------------------

export function buildRequestBody(benchmarkCase, config = {}) {
  assertCaseRow(benchmarkCase);
  const query = buildQueryForRow(benchmarkCase, config);
  const topK = configuredTopK(config);
  const searchMode = configuredSearchMode(config);
  const objective = configuredObjective(config);

  const advancedSettings = {};
  const sourcePolicy = {};
  const includeDomains = buildIncludeDomainsForRow(benchmarkCase, config);
  if (includeDomains.length) sourcePolicy.include_domains = includeDomains;
  const excludeDomains = normalizeList(config.exclude_domains ?? config.excludeDomains);
  if (excludeDomains.length) sourcePolicy.exclude_domains = excludeDomains;
  if (Object.keys(sourcePolicy).length) advancedSettings.source_policy = sourcePolicy;
  if (topK) advancedSettings.max_results = topK;

  const body = {
    search_queries: [query],
    mode: searchMode
  };
  if (objective) body.objective = objective;
  if (Object.keys(advancedSettings).length) body.advanced_settings = advancedSettings;
  return body;
}

// -----------------------------------------------------------------------
// Envelope normalization + citation extraction
// -----------------------------------------------------------------------

function resultText(parallelResult) {
  const parts = [
    parallelResult.title,
    ...(Array.isArray(parallelResult.excerpts) ? parallelResult.excerpts : [])
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

// Convert a single Parallel result into the scorer envelope shape. Only
// STRONG hits (URL cross-ref against gold cl_cluster_id OR caption-class
// citation in excerpts) populate `citation`; loose (reference-only) hits do
// NOT contribute to hitAt{k}. Every match — strong or loose — is captured
// in providerMetadata for downstream analysis.
export function normalizeParallelResult(parallelResult, gold, index) {
  const url = parallelResult.url || '';
  const text = resultText(parallelResult);
  const evidence = extractCitations({ url, text, gold });
  const host = evidence.urlHit?.host ?? null;
  const strong = evidence.strongHit;
  const citation = strong ? (gold?.canonical_citation ?? null) : null;
  const captionCitations = strong
    ? evidence.textMatches
        .filter((m) => m.contextClass === 'caption')
        .map((m) => m.citation)
    : [];
  const excerpt = Array.isArray(parallelResult.excerpts) && parallelResult.excerpts.length
    ? parallelResult.excerpts.join(' … ')
    : null;
  return {
    rank: index + 1,
    title: parallelResult.title ?? null,
    url,
    citation,
    citations: Array.from(new Set(captionCitations)),
    bluebook_citation: citation,
    publisher: publisherFromHost(host),
    date: parallelResult.publish_date ?? parallelResult.publishDate ?? null,
    excerpt,
    summary: null,
    relevance: null,
    result_type: 'case',
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

export function normalizeEnvelope(query, parallelResults, gold, { topK = DEFAULT_TOP_K } = {}) {
  const results = (Array.isArray(parallelResults) ? parallelResults : [])
    .slice(0, topK)
    .map((r, i) => normalizeParallelResult(r, gold, i));
  return {
    query,
    total_available: parallelResults?.length ?? 0,
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

// Parallel error shape: { type: "error", error: { ref_id, message, detail } }.
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
      `parallel-legal-search request exceeded ${requestTimeoutMs}ms: ${timeoutError}`,
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
      `Failed to parse Parallel response JSON: ${responseParseError}`,
      { endpoint, request: redactedRequest, httpStatus, startedAtMs, completedAtMs, rawResponse: responseText }
    );
  }
  if (!responseJson || !Array.isArray(responseJson.results) || responseJson.results.length === 0) {
    return makeFailure(
      benchmarkCase,
      'missing_results',
      'Parallel returned no results for this query + include_domains',
      { endpoint, request: redactedRequest, httpStatus, startedAtMs, completedAtMs, rawResponse: responseJson }
    );
  }

  const gold = benchmarkCase.metadata?.expected ?? {};
  const queryString = Array.isArray(request.search_queries) ? request.search_queries[0] : '';
  const envelope = normalizeEnvelope(queryString, responseJson.results, gold, { topK });
  const extraction = summarizeExtraction(envelope);
  const includeDomains = request.advanced_settings?.source_policy?.include_domains ?? [];

  return {
    caseId: benchmarkCase.caseId,
    status: 'completed',
    rawOutput: {
      endpoint,
      request: redactedRequest,
      httpStatus,
      response: responseJson,
      normalizedResults: envelope.results,
      searchId: responseJson.search_id ?? responseJson.searchId ?? null,
      sessionId: responseJson.session_id ?? responseJson.sessionId ?? null
    },
    finalOutputText: JSON.stringify(envelope),
    artifacts: [],
    providerMetadata: {
      provider: PROVIDER_ID,
      endpoint,
      httpStatus,
      queryMode: request._queryMode,
      domainScope: request._domainScope,
      searchMode: request.mode,
      includeDomains,
      topK,
      resultCount: envelope.result_count,
      totalAvailable: envelope.total_available,
      warnings: Array.isArray(responseJson.warnings) ? responseJson.warnings : [],
      usage: Array.isArray(responseJson.usage) ? responseJson.usage : [],
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

export const parallelLegalSearchProviderAdapter = {
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
        searchMode: (() => { try { return configuredSearchMode(config); } catch { return null; } })(),
        aggregatorHosts: configuredDomainScope(config) === 'primary_plus_aggregators' ? configuredAggregators(config) : [],
        topK: configuredTopK(config),
        requestTimeoutMs: config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
        objective: configuredObjective(config),
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
          : message.includes('unknown query_mode') || message.includes('unknown domain_scope') || message.includes('unknown mode') ? 'config_error'
            : 'validation_error';
      return makeFailure(benchmarkCase, kind, message, { endpoint });
    }

    const apiKeyEnv = config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      return makeFailure(benchmarkCase, 'config_error', `Missing env ${apiKeyEnv}`, { endpoint, request });
    }

    // Tag the outgoing request with the resolved config knobs so the manifest
    // captures them (stripped before serialization, so not sent to Parallel).
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
  DEFAULT_OBJECTIVE,
  assertCaseRow,
  buildIncludeDomainsForRow,
  buildQueryForRow,
  buildRequestBody,
  configuredAggregators,
  configuredDomainScope,
  configuredObjective,
  configuredQueryMode,
  configuredSearchMode,
  configuredTopK,
  isRetryableProviderFailure,
  makeFailure,
  normalizeParallelResult,
  normalizeEnvelope,
  publisherFromHost,
  resultText,
  summarizeExtraction
};
