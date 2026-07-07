// CourtListener citation-lookup provider.
//
// POSTs /api/rest/v4/citation-lookup/ with body {"text": "<query>"}.
//
// Different from courtlistener-search.mjs — that adapter targets the
// opinion-search endpoint with GET + `q=<query>`. This one targets the
// dedicated citation-lookup endpoint that parses raw text (including
// sloppified variants) and returns matching opinion clusters directly.
//
// Auth: Authorization: Token <token> header, optional. Unauthenticated
// calls are allowed (env var configurable, defaults to
// COURTLISTENER_API_TOKEN).
//
// Rate limiting: driven by CourtListenerRateLimiter (same shared class the
// search adapter uses). Bootstraps from CL's overview docs page and falls
// back to the config numbers if the fetch fails. Citation-lookup publishes
// 60 valid citations / minute; hour/day are unspecified for this endpoint,
// so the fallback below sets them equal to per_minute — deliberately
// conservative. Once per_day requests have landed in the last 24h,
// remaining cases short-circuit to provider_failure with kind
// 'quota_exhausted' rather than blocking.
//
// Response normalization: the endpoint returns a top-level JSON array with
// one element per detected citation. We send one citation per call, so we
// take element[0]. Per-citation `status` (200 / 300 / 400 / 404 / 429)
// surfaces at the envelope top level:
//   - 200: single matched cluster.
//   - 300: ambiguous — multiple candidate clusters. Still 'completed'; the
//     scorer decides whether the ground-truth cluster is present.
//   - 400 / 404 / 429 (per-item): 'completed' with empty results
//     and the status preserved, so the scorer can differentiate
//     "provider responded 'no match'" from "provider was unreachable".
// An empty top-level array (non-citation input) yields status:null with
// empty results and normalized_citations arrays.
//
// Envelope results[] items match the shape used by the other CL
// adapters (rank, cluster_id, case_name, citations, url, court_id,
// published_date, result_type, native_score) so the scorer keys on
// cluster_id uniformly across providers.

import { CourtListenerRateLimiter } from './courtlistener-rate-limits.mjs';

const DEFAULT_ENDPOINT = 'https://www.courtlistener.com/api/rest/v4/citation-lookup/';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TOKEN_ENV = 'COURTLISTENER_API_TOKEN';
const DEFAULT_RATE_LIMITS_DOCS_URL =
  'https://wiki.free.law/c/courtlistener/help/api/rest/v4/overview';
const DEFAULT_RATE_LIMITS_FALLBACK = {
  per_minute: 60,
  per_hour: 60,
  per_day: 60
};
const USER_AGENT = 'TrustFoundry-benchmarks/1.0 (mike@trustfoundry.ai)';
const PROVIDER_ID = 'courtlistener-citation-lookup';
const PROVIDER_VERSION = 'courtlistener-citation-lookup-provider-v1';

const MAX_TRANSIENT_RETRIES = 1; // one retry on fetch-error / HTTP 5xx
const TRANSIENT_RETRY_BACKOFF_MS = 500;

const rateLimiterByConfig = new WeakMap();

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (/authorization/i.test(name)) {
      out[name] = value ? '[REDACTED]' : '';
    } else {
      out[name] = value;
    }
  }
  return out;
}

function serializeResponseHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    const out = {};
    for (const [name, value] of headers.entries()) out[name] = value;
    return out;
  }
  if (typeof headers === 'object') return { ...headers };
  return {};
}

async function ensureRateLimiter(config) {
  let limiter = rateLimiterByConfig.get(config);
  if (!limiter) {
    limiter = await CourtListenerRateLimiter.bootstrap({
      docsUrl: config.rate_limits_docs_url ?? DEFAULT_RATE_LIMITS_DOCS_URL,
      fallback: config.rate_limits_fallback ?? DEFAULT_RATE_LIMITS_FALLBACK,
      fetchFn: config._rateLimitsFetchFn,
      now: config._rateLimitsNow,
      onLog: config._rateLimitsSilent
        ? undefined
        : (message) => console.error(message)
    });
    rateLimiterByConfig.set(config, limiter);
  }
  return limiter;
}

async function fetchOnce({ url, headers, body, requestTimeoutMs, fetchFn, limiter }) {
  const sleepMs = limiter.computeSleepMs();
  await sleep(sleepMs);

  const startedAtMs = Date.now();
  const sentAtIso = new Date(startedAtMs).toISOString();
  limiter.recordCall(startedAtMs);

  let httpStatus = null;
  let httpOk = false;
  let payload = null;
  let responseText = null;
  let fetchError = null;
  let parseErrorMessage = null;
  let responseHeaders = null;
  let capturedResponseHeaders = null;

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    httpStatus = response.status;
    httpOk = response.ok;
    responseHeaders = response.headers;
    capturedResponseHeaders = serializeResponseHeaders(response.headers);
    responseText = await response.text();
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch (parseError) {
      parseErrorMessage = `Failed to parse JSON: ${parseError.message}`;
      payload = { _raw: responseText.slice(0, 500) };
    }
  } catch (caught) {
    fetchError = caught instanceof Error ? caught.message : String(caught);
  }

  if (responseHeaders) limiter.applyResponseHeaders(responseHeaders);

  const completedAtMs = Date.now();
  return {
    url,
    sleepMs,
    startedAtMs,
    completedAtMs,
    sentAtIso,
    receivedAtIso: new Date(completedAtMs).toISOString(),
    httpStatus,
    httpOk,
    payload,
    responseText,
    responseHeaders: capturedResponseHeaders ?? {},
    fetchError,
    parseErrorMessage
  };
}

function isRetryableAttempt(attempt) {
  if (attempt.fetchError) return true;
  if (attempt.httpStatus && attempt.httpStatus >= 500) return true;
  return false;
}

async function fetchWithRetry({ url, headers, body, requestTimeoutMs, fetchFn, limiter, onLog }) {
  const attempts = [];
  let finalAttempt = null;
  for (let attemptNumber = 1; attemptNumber <= MAX_TRANSIENT_RETRIES + 1; attemptNumber += 1) {
    const result = await fetchOnce({ url, headers, body, requestTimeoutMs, fetchFn, limiter });
    finalAttempt = result;
    attempts.push({ attempt: attemptNumber, ...result });
    if (!isRetryableAttempt(result)) break;
    if (attemptNumber > MAX_TRANSIENT_RETRIES) break;
    onLog?.(
      `citation-lookup attempt ${attemptNumber} transient failure ` +
        `(${result.fetchError ?? `HTTP ${result.httpStatus}`}); retrying once after ${TRANSIENT_RETRY_BACKOFF_MS}ms.`
    );
    await sleep(TRANSIENT_RETRY_BACKOFF_MS);
  }
  return { attempts, finalAttempt };
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

function pickClusterCitations(cluster) {
  if (Array.isArray(cluster?.citations)) {
    return cluster.citations
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (!entry) return null;
        const { volume, reporter, page } = entry;
        if (volume && reporter && page) return `${volume} ${reporter} ${page}`;
        return entry.cite ?? null;
      })
      .filter(Boolean)
      .map(String);
  }
  return asStringArray(cluster?.citation);
}

function normalizeEnvelope(rawQuery, payload) {
  const items = Array.isArray(payload) ? payload : [];
  if (items.length === 0) {
    return {
      provider: PROVIDER_ID,
      query: rawQuery,
      raw_query: rawQuery,
      status: null,
      provider_ambiguous: false,
      normalized_citations: [],
      results: [],
      result_count: 0,
      total_available: 0
    };
  }
  const item = items[0] ?? {};
  const clusters = Array.isArray(item.clusters) ? item.clusters : [];
  const perItemResults = clusters.map((cluster, index) => {
    const clusterId = cluster?.id != null ? String(cluster.id) : null;
    return {
      rank: index + 1,
      cluster_id: clusterId,
      case_name: cluster?.case_name ?? cluster?.caseName ?? null,
      citations: pickClusterCitations(cluster),
      url: cluster?.absolute_url
        ? `https://www.courtlistener.com${cluster.absolute_url}`
        : null,
      court_id: cluster?.court_id ?? null,
      published_date: cluster?.date_filed ?? cluster?.dateFiled ?? null,
      result_type: 'case',
      native_score: null
    };
  });
  return {
    provider: PROVIDER_ID,
    query: rawQuery,
    raw_query: rawQuery,
    status: item.status ?? null,
    provider_ambiguous: item.status === 300,
    normalized_citations: asStringArray(item.normalized_citations),
    results: perItemResults,
    result_count: perItemResults.length,
    total_available: perItemResults.length,
    error_message: item.error_message ?? null
  };
}

function classifyTerminalError(attempt) {
  if (attempt.fetchError) {
    return { kind: 'fetch_error', message: attempt.fetchError };
  }
  if (!attempt.httpOk) {
    if (attempt.httpStatus === 429) {
      return { kind: 'rate_limited', message: 'HTTP 429', status: 429 };
    }
    return {
      kind: 'http_error',
      message: `HTTP ${attempt.httpStatus}`,
      status: attempt.httpStatus
    };
  }
  if (attempt.parseErrorMessage) {
    return { kind: 'parse_error', message: attempt.parseErrorMessage };
  }
  return null;
}

function makeShortCircuitFailure(benchmarkCase, kind, message) {
  const now = new Date().toISOString();
  return {
    caseId: benchmarkCase.caseId,
    status: 'provider_failure',
    rawOutput: { error: { kind, message } },
    finalOutputText: JSON.stringify({
      provider: PROVIDER_ID,
      query: benchmarkCase.prompt ?? '',
      raw_query: benchmarkCase.prompt ?? '',
      status: null,
      provider_ambiguous: false,
      normalized_citations: [],
      results: [],
      result_count: 0,
      total_available: 0
    }),
    artifacts: [],
    providerMetadata: { provider: PROVIDER_ID, error: kind },
    timing: { startedAt: now, completedAt: now, durationMs: 0 },
    tokenUsage: null,
    retryMetadata: null,
    error: { kind, message }
  };
}

export const courtlistenerCitationLookupProviderAdapter = {
  id: PROVIDER_ID,
  version: PROVIDER_VERSION,

  async describe({ config = {} }) {
    const limiter = await ensureRateLimiter(config);
    return {
      id: this.id,
      version: this.version,
      target: config.endpoint ?? DEFAULT_ENDPOINT,
      tokenEnv: config.token_env ?? config.tokenEnv ?? DEFAULT_TOKEN_ENV,
      settings: {
        requestTimeoutMs: config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
        rateLimits: limiter.describe()
      }
    };
  },

  async executeCase({ benchmarkCase, config = {} }) {
    const rawQuery = benchmarkCase.prompt ?? '';
    if (!rawQuery) {
      return makeShortCircuitFailure(benchmarkCase, 'validation_error', 'Empty query');
    }

    const limiter = await ensureRateLimiter(config);
    if (limiter.isQuotaExhausted()) {
      return makeShortCircuitFailure(
        benchmarkCase,
        'quota_exhausted',
        `CourtListener daily quota (${limiter.limits.per_day}) reached; try again later or resume with --offset`
      );
    }

    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    const requestTimeoutMs = config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const tokenEnv = config.token_env ?? config.tokenEnv ?? DEFAULT_TOKEN_ENV;
    const token = process.env[tokenEnv];
    const fetchFn = config._fetch ?? globalThis.fetch;

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    };
    if (token) headers.Authorization = `Token ${token}`;

    const body = JSON.stringify({ text: rawQuery });
    const onLog = config._rateLimitsSilent ? undefined : (message) => console.error(message);

    const overallStartedAtMs = Date.now();
    const { attempts, finalAttempt } = await fetchWithRetry({
      url: endpoint,
      headers,
      body,
      requestTimeoutMs,
      fetchFn,
      limiter,
      onLog
    });
    const overallCompletedAtMs = Date.now();

    const auditAttempts = attempts.map((attempt) => ({
      attempt: attempt.attempt,
      request: {
        method: 'POST',
        url: attempt.url,
        headers: redactHeaders(headers),
        body,
        sentAt: attempt.sentAtIso
      },
      response: {
        httpStatus: attempt.httpStatus,
        ok: attempt.httpOk,
        headers: attempt.responseHeaders,
        body: attempt.responseText ?? null,
        receivedAt: attempt.receivedAtIso,
        durationMs: attempt.completedAtMs - attempt.startedAtMs,
        fetchError: attempt.fetchError,
        parseError: attempt.parseErrorMessage
      }
    }));

    const terminalError = classifyTerminalError(finalAttempt);
    const status = terminalError ? 'provider_failure' : 'completed';
    const envelope = terminalError
      ? null
      : normalizeEnvelope(rawQuery, finalAttempt.payload);

    const finalOutputText = envelope
      ? JSON.stringify(envelope)
      : JSON.stringify({
          provider: PROVIDER_ID,
          query: rawQuery,
          raw_query: rawQuery,
          status: null,
          provider_ambiguous: false,
          normalized_citations: [],
          results: [],
          result_count: 0,
          total_available: 0
        });

    return {
      caseId: benchmarkCase.caseId,
      status,
      rawOutput: {
        endpoint,
        query: rawQuery,
        attempts: auditAttempts,
        finalHttpStatus: finalAttempt.httpStatus,
        finalItemStatus: envelope?.status ?? null
      },
      finalOutputText,
      artifacts: [],
      providerMetadata: {
        provider: PROVIDER_ID,
        endpoint,
        httpStatus: finalAttempt.httpStatus,
        itemStatus: envelope?.status ?? null,
        resultsReturned: envelope?.results.length ?? 0,
        rateLimits: limiter.describe(),
        attempts: auditAttempts.length
      },
      timing: {
        startedAt: new Date(overallStartedAtMs).toISOString(),
        completedAt: new Date(overallCompletedAtMs).toISOString(),
        durationMs: overallCompletedAtMs - overallStartedAtMs
      },
      tokenUsage: null,
      retryMetadata:
        auditAttempts.length > 1
          ? { attempts: auditAttempts.length, retried: true }
          : null,
      error: terminalError
    };
  }
};

export const _internals = {
  DEFAULT_ENDPOINT,
  DEFAULT_RATE_LIMITS_FALLBACK,
  PROVIDER_ID,
  normalizeEnvelope,
  classifyTerminalError,
  makeShortCircuitFailure,
  pickClusterCitations
};
