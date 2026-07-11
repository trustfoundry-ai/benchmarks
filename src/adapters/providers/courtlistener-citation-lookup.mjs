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
// search adapter uses). Two paths:
//   1. `token_env` value present → authenticated tier. Skip the docs
//      bootstrap and use the empirical citation-lookup limits (10/min AND
//      100/hour, confirmed from CL's own 429 response bodies — the docs
//      page's advertised 60/min is not what the server enforces).
//   2. `token_env` value absent → anonymous. Bootstrap from CL's overview
//      docs URL (parses the 5/min, 50/hour, 125/day numbers) and fall back
//      to those same numbers if the fetch fails.
//
// Retry behavior:
//   - fetch error / HTTP 5xx → one transient retry with a fixed 500ms backoff.
//   - HTTP 429 → sleep for Retry-After seconds (fall back to 60s), retry up
//     to `MAX_RATE_LIMIT_RETRIES` times before surfacing as provider_failure.
//   - Between cases the shared limiter's `computeSleepMs()` honors any
//     `serverReset` set by prior Retry-After / X-RateLimit-Reset headers,
//     so a legitimate CL cool-down (per-minute ≤60s, per-hour ~15–20 min)
//     just blocks the next case's request until the window opens.
//   - Above `MAX_HONORED_BACKOFF_MS` (default 1 hour) the adapter refuses to
//     wait: pre-flight `computeSleepMs > cap` and 429s with `Retry-After >
//     cap` both short-circuit the case as `quota_exhausted`. In practice this
//     catches CL's per-day / IP-ban signal (observed empirically as a
//     ~76,997-second Retry-After ≈ 21 hours). Override via config knob
//     `max_honored_backoff_ms`. Set `config.abort_on_backoff = true` to flip
//     back to the old fail-fast-at-5-min behavior.
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
// Anonymous fallback matches CL's docs-page-published anonymous limits.
// Used when no token is set AND the docs fetch fails.
const DEFAULT_RATE_LIMITS_ANONYMOUS = {
  per_minute: 5,
  per_hour: 50,
  per_day: 125
};
// Authenticated citation-lookup limits determined empirically from CL's own
// 429 response bodies: "Rate limit exceeded: 10/min" AND "100/hour". CL's
// docs page advertises 60/min, but the server enforces 10/min in practice —
// trust the 429s. per_day isn't a published cap; we set it very generously
// so it never triggers before per_hour does. When per_hour is exhausted, the
// adapter short-circuits with kind='quota_exhausted' rather than sleeping
// through a multi-hour Retry-After, so the caller can decide whether to
// resume later (via --offset) or reroute their request.
const DEFAULT_RATE_LIMITS_AUTHENTICATED = {
  per_minute: 10,
  per_hour: 100,
  per_day: 5000
};
// Retained for callers that still pass rate_limits_fallback in their config;
// its meaning depends on auth state at construction time.
const DEFAULT_RATE_LIMITS_FALLBACK = DEFAULT_RATE_LIMITS_ANONYMOUS;
const USER_AGENT = 'TrustFoundry-benchmarks/1.0 (mike@trustfoundry.ai)';
const PROVIDER_ID = 'courtlistener-citation-lookup';
const PROVIDER_VERSION = 'courtlistener-citation-lookup-provider-v1';

const MAX_TRANSIENT_RETRIES = 1; // one retry on fetch-error / HTTP 5xx
const TRANSIENT_RETRY_BACKOFF_MS = 500;
const MAX_RATE_LIMIT_RETRIES = 2; // up to 2 sleeps on 429 (using Retry-After)
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 60_000; // when 429 lacks a usable Retry-After
const LONG_SLEEP_LOG_THRESHOLD_MS = 30_000;
// Cap the Retry-After / computeSleepMs value we're willing to honor. CL's
// per_minute (≤60s) and per_hour (up to ~20 min) cool-downs are legitimate
// waits; the per_day cap surfaces as a ~21-hour Retry-After that no
// reasonable benchmark should sleep through. When the header exceeds this
// cap the adapter short-circuits the case with kind='quota_exhausted' so the
// caller can decide whether to resume later (`--offset`) or reroute.
const MAX_HONORED_BACKOFF_MS = 60 * 60_000; // 1 hour

const rateLimiterByConfig = new WeakMap();

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Parses HTTP Retry-After (seconds-as-integer OR HTTP-date form) into ms.
// Returns null for missing / unparseable values; callers should treat null
// as "no usable header, use a fallback".
function retryAfterToMs(retryAfter) {
  if (retryAfter === null || retryAfter === undefined || retryAfter === '') return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const parsed = Date.parse(retryAfter);
  if (!Number.isFinite(parsed)) return null;
  const delta = parsed - Date.now();
  return delta > 0 ? delta : 0;
}

function extractRetryAfterMs(headers) {
  if (!headers) return null;
  const value = headers['retry-after'] ?? headers['Retry-After'] ?? null;
  return retryAfterToMs(value);
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

function tokenPresent(config) {
  const tokenEnv = config.token_env ?? config.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const value = process.env[tokenEnv];
  return typeof value === 'string' && value.length > 0;
}

async function ensureRateLimiter(config) {
  let limiter = rateLimiterByConfig.get(config);
  if (!limiter) {
    const onLog = config._rateLimitsSilent ? undefined : (message) => console.error(message);
    if (tokenPresent(config)) {
      // Authenticated: the CL citation-lookup endpoint publishes 60/min for
      // token-bearing callers. Skip the docs-page bootstrap — it parses the
      // free-tier anonymous limits (5/min, 50/hour, 125/day) which are wrong
      // for authenticated calls and would throttle us to a crawl.
      const limits = config.rate_limits_authenticated ?? DEFAULT_RATE_LIMITS_AUTHENTICATED;
      limiter = new CourtListenerRateLimiter({
        limits,
        source: 'authenticated',
        docsUrl: null,
        now: config._rateLimitsNow
      });
      onLog?.(
        `CourtListener rate limits (authenticated tier): ${JSON.stringify(limiter.limits)}`
      );
    } else {
      // Anonymous: bootstrap from the docs page, falling back to the
      // published anonymous limits if the fetch/parse fails.
      limiter = await CourtListenerRateLimiter.bootstrap({
        docsUrl: config.rate_limits_docs_url ?? DEFAULT_RATE_LIMITS_DOCS_URL,
        fallback:
          config.rate_limits_anonymous ??
          config.rate_limits_fallback ??
          DEFAULT_RATE_LIMITS_ANONYMOUS,
        fetchFn: config._rateLimitsFetchFn,
        now: config._rateLimitsNow,
        onLog
      });
    }
    rateLimiterByConfig.set(config, limiter);
  }
  return limiter;
}

async function fetchOnce({ url, headers, body, requestTimeoutMs, fetchFn, limiter, onLog }) {
  const sleepMs = limiter.computeSleepMs();
  if (sleepMs >= LONG_SLEEP_LOG_THRESHOLD_MS) {
    const seconds = Math.round(sleepMs / 1000);
    onLog?.(
      `citation-lookup sleeping ${seconds}s to honor CourtListener rate-limit reset before next request…`
    );
  }
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

// Retry classification for a single attempt. Returns:
//   - { kind: 'transient', sleepMs } — fetch error or HTTP 5xx; short fixed sleep.
//   - { kind: 'rate_limited', sleepMs } — HTTP 429; sleep for Retry-After
//     (falling back to RATE_LIMIT_FALLBACK_BACKOFF_MS if the header is missing
//     or unusable).
//   - null — attempt is terminal (success, or a non-retryable error like 4xx).
function classifyRetry(attempt) {
  if (attempt.fetchError) return { kind: 'transient', sleepMs: TRANSIENT_RETRY_BACKOFF_MS };
  if (!attempt.httpStatus) return null;
  if (attempt.httpStatus >= 500) return { kind: 'transient', sleepMs: TRANSIENT_RETRY_BACKOFF_MS };
  if (attempt.httpStatus === 429) {
    const headerSleep = extractRetryAfterMs(attempt.responseHeaders);
    // If CL asks us to wait longer than we're willing to honor, give up on
    // retries — the outer terminal-error classifier turns this into a clean
    // provider_failure kind='rate_limited' rather than a marathon sleep.
    if (headerSleep !== null && headerSleep > MAX_HONORED_BACKOFF_MS) return null;
    return { kind: 'rate_limited', sleepMs: headerSleep ?? RATE_LIMIT_FALLBACK_BACKOFF_MS };
  }
  return null;
}

async function fetchWithRetry({ url, headers, body, requestTimeoutMs, fetchFn, limiter, onLog }) {
  const attempts = [];
  let finalAttempt = null;
  let transientUsed = 0;
  let rateLimitedUsed = 0;
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    const result = await fetchOnce({ url, headers, body, requestTimeoutMs, fetchFn, limiter, onLog });
    finalAttempt = result;
    attempts.push({ attempt: attemptNumber, ...result });
    const retry = classifyRetry(result);
    if (retry === null) break;
    if (retry.kind === 'transient') {
      if (transientUsed >= MAX_TRANSIENT_RETRIES) break;
      transientUsed += 1;
      onLog?.(
        `citation-lookup attempt ${attemptNumber} transient failure ` +
          `(${result.fetchError ?? `HTTP ${result.httpStatus}`}); retrying after ${retry.sleepMs}ms.`
      );
    } else if (retry.kind === 'rate_limited') {
      if (rateLimitedUsed >= MAX_RATE_LIMIT_RETRIES) break;
      rateLimitedUsed += 1;
      const seconds = Math.round(retry.sleepMs / 1000);
      onLog?.(
        `citation-lookup attempt ${attemptNumber} got HTTP 429; ` +
          `honoring Retry-After (${seconds}s / ${retry.sleepMs}ms) then retrying.`
      );
    }
    await sleep(retry.sleepMs);
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

// Build a message that reflects which specific window the limiter reports as
// exhausted, not a hardcoded "daily quota" claim. Trigger paths:
//   - 'per_hour' or 'per_day' — local sliding-window count meets the cap.
//   - 'server_backoff' — CL's Retry-After / X-RateLimit-Reset header pushes
//     the next allowed call more than 5 minutes into the future; the caller
//     should switch strategy rather than sleep through it.
function describeQuotaExhaustion(limiter, windowKey) {
  if (windowKey === 'server_backoff') {
    const now = Date.now();
    const waitMs = Math.max(0, (limiter.serverReset ?? now) - now);
    const waitSeconds = Math.round(waitMs / 1000);
    return (
      `CourtListener server-side backoff requires waiting ~${waitSeconds}s ` +
      `before the next request; short-circuiting remaining cases. ` +
      `Try again after the backoff window or resume with --offset.`
    );
  }
  const limit = limiter.limits?.[windowKey];
  return (
    `CourtListener local ${windowKey} sliding-window cap (${limit}) reached; ` +
    `try again later or resume with --offset.`
  );
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
    // Pre-flight sanity: honor CL's Retry-After / X-RateLimit-Reset for
    // per-minute and per-hour cool-downs (adapter sleeps through them in
    // fetchOnce), but short-circuit anything past MAX_HONORED_BACKOFF_MS —
    // that's a per_day / ban signal (empirically ~21 hours) and no benchmark
    // run should sleep through it. `config.abort_on_backoff` restores the old
    // fail-fast behavior at the exhaustedWindow horizon (5 minutes).
    const preSleepMs = limiter.computeSleepMs();
    const maxHonoredMs = config.max_honored_backoff_ms ?? MAX_HONORED_BACKOFF_MS;
    if (preSleepMs > maxHonoredMs) {
      const seconds = Math.round(preSleepMs / 1000);
      const capSeconds = Math.round(maxHonoredMs / 1000);
      return makeShortCircuitFailure(
        benchmarkCase,
        'quota_exhausted',
        `CourtListener signaled a ${seconds}s backoff exceeding max_honored_backoff_ms (${capSeconds}s) — likely a per-day / IP-level cap. Resume with --offset after the window resets.`
      );
    }
    if (config.abort_on_backoff) {
      const exhausted = limiter.exhaustedWindow();
      if (exhausted !== null) {
        const message = describeQuotaExhaustion(limiter, exhausted);
        return makeShortCircuitFailure(benchmarkCase, 'quota_exhausted', message);
      }
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
  DEFAULT_RATE_LIMITS_ANONYMOUS,
  DEFAULT_RATE_LIMITS_AUTHENTICATED,
  DEFAULT_RATE_LIMITS_FALLBACK,
  MAX_HONORED_BACKOFF_MS,
  PROVIDER_ID,
  normalizeEnvelope,
  classifyTerminalError,
  makeShortCircuitFailure,
  pickClusterCitations,
  tokenPresent,
  ensureRateLimiter,
  describeQuotaExhaustion
};
