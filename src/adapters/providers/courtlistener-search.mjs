// CourtListener opinion-search provider.
//
// GETs /api/rest/v4/search/?type=o&q=<query>&page_size=<N>&semantic=true
//   &court=<court_ids space-separated>.
//
// Two hardcoded invariants (not config knobs):
//   1. semantic=true — every call sends it, so a run cannot end up with a
//      mixed BM25/semantic result set by accident.
//   2. jurisdiction_filter — every call scopes to the case's state
//      (metadata.state / geo_level_2_identifier) using the
//      state_appellate_supreme court set (state → supreme + appellate; FED
//      → federal appellate + district + bankruptcy). This mirrors what the
//      TrustFoundry provider does via body.state, keeping the two runs
//      apples-to-apples. Court IDs go in the URL's `court=` param, so the
//      `q=` search text stays clean and doesn't consume its length budget
//      or pollute semantic scoring.
//
// Auth: Authorization: Token <token> header (env var configurable, defaults
// to COURTLISTENER_API_TOKEN).
//
// Rate limiting: driven by CourtListenerRateLimiter, which bootstraps from
// CL's docs page at startup and falls back to config values if that fetch
// fails. The limiter tracks a sliding window per per_minute/per_hour/per_day
// window and computes the minimum sleep before each call. Once per_day
// requests have landed in the last 24h, remaining cases short-circuit to
// provider_failure with kind='quota_exhausted' rather than blocking for
// hours.
//
// Pagination: CL v4 does NOT document a `page_size` parameter and silently
// caps a single response at 20 results regardless of what we ask for. To
// score `hits@25` consistently with the TrustFoundry provider, we
// cursor-paginate: page 1 always fires; if it returns exactly 20 results
// AND advertises a `next` cursor AND we still need more results AND the
// daily quota isn't spent, we fire page 2 and take the top-25 combined.
// Page 2 is skipped when page 1 already has enough (e.g. an unusual query
// that returned <20 hits) so we don't waste API budget. Both pages are
// preserved verbatim in the audit capture under `pages: [...]`.
//
// Docs: https://wiki.free.law/c/courtlistener/help/api/rest/v4/overview

import {
  buildJurisdictionFilteredQuery,
  prepareJurisdictionFilteredQuery,
  resolveJurisdictionFilterSettings
} from './courtlistener-jurisdictions.mjs';
import { CourtListenerRateLimiter } from './courtlistener-rate-limits.mjs';

const DEFAULT_ENDPOINT = 'https://www.courtlistener.com/api/rest/v4/search/';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_TOP_K = 25;
const DEFAULT_TOKEN_ENV = 'COURTLISTENER_API_TOKEN';
const USER_AGENT = 'TrustFoundry-benchmarks/1.0 (benchmarks@trustfoundry.ai)';
const PROVIDER_ID = 'courtlistener-search';
const PROVIDER_VERSION = 'courtlistener-search-provider-v1';
// Jurisdiction filter is a hardcoded invariant (see file header). state case
// rows filter to state supreme + appellate courts; FED rows filter to the
// federal appellate/district/bankruptcy set defined in
// courtlistener-jurisdictions.mjs (FEDERAL_DEFAULT).
const JURISDICTION_FILTER_MODE = 'state_appellate_supreme';

function jurisdictionInvariantConfig(config) {
  return {
    ...config,
    jurisdiction_filter: { mode: JURISDICTION_FILTER_MODE }
  };
}

const rateLimiterByConfig = new WeakMap();

const RAW_RESPONSES_DIR = 'raw-responses';

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Turn a caseId like "trustfoundry-legal-search:case_questions:test:76eaa"
// into a filesystem-safe leaf without losing readability. Colons, slashes,
// and other reserved-on-Windows characters are collapsed to underscores.
function sanitizeCaseIdForFilename(caseId) {
  const raw = typeof caseId === 'string' && caseId ? caseId : 'unknown-case';
  return raw.replace(/[^A-Za-z0-9._-]+/g, '_');
}

// Copy request headers into a plain object with the Authorization value
// redacted. The redacted marker preserves whether a token was present
// (auditors can see if a call was authenticated) without leaking secrets
// into any published or shared run directory.
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

// Materialize a fetch Response's headers as a plain object. Handles both
// the WHATWG Headers instance (with .entries()) and the Map form used in
// tests. Response headers are safe to record verbatim.
function serializeResponseHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    const out = {};
    for (const [name, value] of headers.entries()) out[name] = value;
    return out;
  }
  if (typeof headers === 'object') {
    return { ...headers };
  }
  return {};
}

function positiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requestLimitFromConfig(config) {
  return positiveInteger(config.limit ?? config.request_limit ?? config.requestLimit);
}

function effectiveTopK(config) {
  return positiveInteger(
    config.top_k ?? config.topK,
    requestLimitFromConfig(config) ?? DEFAULT_TOP_K
  );
}

function effectivePageSize(config, topK) {
  const configured = positiveInteger(config.page_size ?? config.pageSize, DEFAULT_PAGE_SIZE);
  const limit = requestLimitFromConfig(config) ?? 0;
  return Math.max(configured, limit, topK);
}

// CL's `q` parser still parses parens as Lucene grouping syntax even under
// semantic=true, and rejects requests where they're unbalanced (HTTP 400
// "The query contains unbalanced parentheses."). We observed this in the
// key-facts dataset where a synthetic-prompt truncation left a trailing
// unclosed `(`. Narrow fix: if the query has more open than close parens,
// trim trailing `(` characters (and their adjacent whitespace/quotes) until
// balanced. Queries with balanced parens are left untouched so their
// behavior on CL's side stays unchanged.
function balanceTrailingParens(query) {
  if (typeof query !== 'string') return '';
  const opens = (query.match(/\(/g) || []).length;
  const closes = (query.match(/\)/g) || []).length;
  if (opens <= closes) return query;
  let out = query;
  let excess = opens - closes;
  while (excess > 0) {
    const trimmed = out.replace(/[\s"]*\([\s"]*$/, '');
    if (trimmed === out) break; // no trailing '(' to remove
    out = trimmed;
    excess -= 1;
  }
  return out;
}

function buildUrl(endpoint, query, { pageSize, courtIds = [], cursor = null }) {
  const url = new URL(endpoint);
  url.searchParams.set('type', 'o');
  url.searchParams.set('q', balanceTrailingParens(query));
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('semantic', 'true');
  if (courtIds.length) {
    url.searchParams.set('court', [...new Set(courtIds)].sort().join(' '));
  }
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

// CL's `next` field is a full URL that echoes the original query plus a
// `cursor=...` param. We only pull the cursor value out of it and rebuild
// our own URL — that way a malformed or unexpectedly-redirecting `next`
// can't drag us off-host.
function extractCursor(nextUrl) {
  if (typeof nextUrl !== 'string' || !nextUrl) return null;
  try {
    return new URL(nextUrl).searchParams.get('cursor');
  } catch {
    return null;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

// Accepts either a single-page payload or `{ results, totalAvailable }` for
// the multi-page case. `results` is the pre-combined, correctly-ordered
// list from page 1 + page 2; `totalAvailable` is page 1's `count` (the
// full-corpus match count, not just what we retrieved).
//
// Note on retention: we preserve EVERY result we fetched (typically up to
// ~40 across two pages). Scoring cutoffs (hit@1/5/10/25) are applied by the
// scorer against these ranked results — we don't truncate here. This keeps
// the audit trail complete and lets future re-scores against different K
// values reuse the same raw data without re-hitting CL. `topK` is passed
// only for shape compatibility with the caller; it is intentionally NOT
// used to slice.
function normalizeEnvelope(query, source, _opts = {}) {
  let results;
  let totalAvailable;
  if (Array.isArray(source)) {
    results = source;
    totalAvailable = source.length;
  } else if (source && Array.isArray(source.results) && !('count' in source)) {
    // Multi-page shape: { results, totalAvailable }
    results = source.results;
    totalAvailable = source.totalAvailable ?? results.length;
  } else {
    // Single-page shape: raw CL payload with `count` and `results`
    results = Array.isArray(source?.results) ? source.results : [];
    totalAvailable = source?.count ?? results.length;
  }
  return {
    query,
    total_available: totalAvailable,
    result_count: results.length,
    results: results.map((row, index) => {
      const citations = [
        ...asArray(row.citation),
        ...asArray(row.neutralCite ?? row.neutral_cite),
        ...asArray(row.lexisCite ?? row.lexis_cite)
      ];
      const opinionIds = Array.isArray(row.opinions)
        ? row.opinions
            .map((opinion) => opinion?.id)
            .filter((id) => id !== undefined && id !== null)
            .map(String)
        : [];
      return {
        rank: index + 1,
        title: row.caseName ?? row.case_name ?? null,
        citation: citations.length ? citations.join('; ') : null,
        citations,
        excerpt: row.snippet ?? null,
        doc_id:
          row.id != null
            ? String(row.id)
            : row.cluster_id != null
              ? String(row.cluster_id)
              : null,
        cluster_id: row.cluster_id != null ? String(row.cluster_id) : null,
        opinion_ids: opinionIds,
        url: row.absolute_url
          ? `https://www.courtlistener.com${row.absolute_url}`
          : null,
        court_id: row.court_id ?? null,
        published_date: row.dateFiled ?? null,
        result_type: 'case',
        native_score: row.meta?.score?.bm25 ?? row.score ?? null
      };
    })
  };
}

async function ensureRateLimiter(config) {
  let limiter = rateLimiterByConfig.get(config);
  if (!limiter) {
    limiter = await CourtListenerRateLimiter.bootstrap({
      docsUrl: config.rate_limits_docs_url ?? undefined,
      fallback: config.rate_limits_fallback ?? undefined,
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

// CL v4 caps a single response at 20 results (no page_size parameter is
// honored). We treat "page returned exactly this many" as the signal that
// another page might exist. Kept as a constant so the pagination trigger
// stays legible.
const CL_MAX_PAGE_SIZE = 20;

// 429 backoff: on Rate Limit Exceeded, CL returns a `Retry-After` header
// (in seconds) telling us when the affected quota window frees up. We
// honor that value and retry the same page once. If the retry still fails
// (or CL sends an unusable Retry-After), we return the 429 as-is and let
// the case surface as a provider_failure — the operator can resume with
// --offset later. The MAX cap is a safety valve so a bad header can't
// stall a chunk run indefinitely: waits longer than this get treated as
// non-retryable.
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000; // 15 minutes
const RETRY_ON_STATUS = new Set([429]);
const MAX_ATTEMPTS_PER_PAGE = 2; // 1 original + 1 retry

// Fetches a single page from CL. Handles rate-limiter sleep+record, the
// fetch itself, JSON parsing, and error classification. Returns everything
// the caller needs to (a) decide whether to fetch a second page and (b)
// build the audit-capture entry for this page. Does NOT mutate any shared
// state beyond the rate limiter.
async function fetchOnePage({
  url,
  headers,
  requestTimeoutMs,
  fetchFn,
  limiter
}) {
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
  let retryAfter = null;
  let responseHeaders = null;
  let capturedResponseHeaders = null;

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    httpStatus = response.status;
    httpOk = response.ok;
    responseHeaders = response.headers;
    capturedResponseHeaders = serializeResponseHeaders(response.headers);
    retryAfter = response.headers?.get?.('retry-after') ?? null;
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
    retryAfter,
    fetchError,
    parseErrorMessage
  };
}

// Builds the per-attempt entry in the audit `pages` array. Header
// redaction happens here so token values never touch disk. `attempt`
// distinguishes the initial call (1) from a Retry-After retry (2).
function pageAuditEntry(pageNumber, attempt, page, requestHeaders, cursor) {
  return {
    page: pageNumber,
    attempt,
    request: {
      method: 'GET',
      url: page.url,
      headers: redactHeaders(requestHeaders),
      cursor: cursor ?? null,
      sentAt: page.sentAtIso
    },
    response: {
      httpStatus: page.httpStatus,
      ok: page.httpOk,
      headers: page.responseHeaders,
      body: page.responseText ?? null,
      receivedAt: page.receivedAtIso,
      durationMs: page.completedAtMs - page.startedAtMs,
      fetchError: page.fetchError,
      parseError: page.parseErrorMessage,
      retryAfter: page.retryAfter
    }
  };
}

// Parses the Retry-After header (seconds or HTTP date form) into an ms
// value clamped to the safety cap. Returns null when the header is
// missing, unparseable, negative, or would sleep longer than the cap.
function retryAfterToMs(retryAfter, now = Date.now()) {
  if (retryAfter === null || retryAfter === undefined || retryAfter === '') return null;
  const seconds = Number(retryAfter);
  let ms = null;
  if (Number.isFinite(seconds)) {
    // Numeric form (integer seconds). Reject negatives outright — a
    // negative delay is nonsense; do not silently clamp to 0.
    if (seconds < 0) return null;
    ms = seconds * 1000;
  } else {
    // HTTP-date form. Reject if parse fails or the timestamp is in the past.
    const parsed = Date.parse(retryAfter);
    if (!Number.isFinite(parsed) || parsed <= now) return null;
    ms = parsed - now;
  }
  if (ms > MAX_RETRY_AFTER_MS) return null;
  return ms;
}

// Fetches a single page with at most one Retry-After retry on 429. Returns
// { attempts: [{page, attempt, ...}...], finalPage }. `finalPage` is the
// last attempt's `fetchOnePage` result — that's what the caller uses to
// decide whether to fetch page 2 and to classify errors. Every attempt is
// preserved in `attempts` for the audit trail.
async function fetchPageWithRetry({
  pageNumber,
  url,
  headers,
  cursor,
  requestTimeoutMs,
  fetchFn,
  limiter,
  onLog
}) {
  const attempts = [];
  let finalPage = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt += 1) {
    const page = await fetchOnePage({
      url,
      headers,
      requestTimeoutMs,
      fetchFn,
      limiter
    });
    finalPage = page;
    attempts.push(pageAuditEntry(pageNumber, attempt, page, headers, cursor));
    if (!RETRY_ON_STATUS.has(page.httpStatus) || attempt >= MAX_ATTEMPTS_PER_PAGE) break;
    const backoffMs = retryAfterToMs(page.retryAfter);
    if (backoffMs === null) break; // unusable header → give up rather than stall
    onLog?.(
      `CL page ${pageNumber} got HTTP 429; honoring Retry-After ${page.retryAfter}s ` +
        `(${backoffMs}ms) then retrying once.`
    );
    await sleep(backoffMs);
  }
  return { attempts, finalPage };
}

function classifyPageError(page) {
  if (page.fetchError) {
    return { kind: 'fetch_error', message: page.fetchError };
  }
  if (!page.httpOk) {
    return { kind: 'http_error', message: `HTTP ${page.httpStatus}`, status: page.httpStatus };
  }
  if (page.parseErrorMessage) {
    return { kind: 'parse_error', message: page.parseErrorMessage };
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
      query: benchmarkCase.prompt ?? '',
      results: [],
      result_count: 0,
      total_available: null
    }),
    artifacts: [],
    providerMetadata: { provider: PROVIDER_ID, error: kind },
    timing: { startedAt: now, completedAt: now, durationMs: 0 },
    tokenUsage: null,
    retryMetadata: null,
    error: { kind, message }
  };
}

export const courtlistenerSearchProviderAdapter = {
  id: PROVIDER_ID,
  version: PROVIDER_VERSION,

  async describe({ config = {} }) {
    const jurisdictionFilter = resolveJurisdictionFilterSettings(
      jurisdictionInvariantConfig(config)
    );
    const limiter = await ensureRateLimiter(config);
    return {
      id: this.id,
      version: this.version,
      target: config.endpoint ?? DEFAULT_ENDPOINT,
      tokenEnv: config.token_env ?? config.tokenEnv ?? DEFAULT_TOKEN_ENV,
      settings: {
        requestTimeoutMs: config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
        pageSize: effectivePageSize(config, effectiveTopK(config)),
        topK: effectiveTopK(config),
        semantic: true,
        rateLimits: limiter.describe(),
        jurisdictionFilter: {
          mode: jurisdictionFilter.mode,
          mappingPath: jurisdictionFilter.mappingPath,
          stateJurisdictions: jurisdictionFilter.stateJurisdictions,
          federalJurisdictions: jurisdictionFilter.federalJurisdictions,
          requireInUse: jurisdictionFilter.requireInUse,
          invariant: true
        }
      }
    };
  },

  async executeCase({ benchmarkCase, config = {} }) {
    const rawQuery = benchmarkCase.prompt ?? '';
    if (!rawQuery) {
      return makeShortCircuitFailure(benchmarkCase, 'validation_error', 'Empty query');
    }

    const limiter = await ensureRateLimiter(config);
    const exhaustedWindow = limiter.exhaustedWindow();
    if (exhaustedWindow) {
      const detail =
        exhaustedWindow === 'server_backoff'
          ? 'server signaled a long Retry-After (>5 min)'
          : `${exhaustedWindow} quota (${limiter.limits[exhaustedWindow]}) reached`;
      return makeShortCircuitFailure(
        benchmarkCase,
        'quota_exhausted',
        `CourtListener ${detail}; the adapter honors CL's Retry-After / X-RateLimit-Reset header, and resume with --resume once the window resets`
      );
    }

    let jurisdictionQuery;
    try {
      jurisdictionQuery = await prepareJurisdictionFilteredQuery(
        rawQuery,
        benchmarkCase,
        jurisdictionInvariantConfig(config)
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return makeShortCircuitFailure(benchmarkCase, 'jurisdiction_filter_error', message);
    }

    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    const requestTimeoutMs = config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const topK = effectiveTopK(config);
    const pageSize = effectivePageSize(config, topK);
    const tokenEnv = config.token_env ?? config.tokenEnv ?? DEFAULT_TOKEN_ENV;
    const token = process.env[tokenEnv];
    const fetchFn = config._fetch ?? globalThis.fetch;

    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    if (token) headers.Authorization = `Token ${token}`;

    const onLog = config._rateLimitsSilent ? undefined : (message) => console.error(message);

    // --- Page 1 (with Retry-After retry on 429) ---
    const page1Url = buildUrl(endpoint, jurisdictionQuery.query, {
      pageSize,
      courtIds: jurisdictionQuery.courtIds
    });
    const page1Result = await fetchPageWithRetry({
      pageNumber: 1,
      url: page1Url,
      headers,
      cursor: null,
      requestTimeoutMs,
      fetchFn,
      limiter,
      onLog
    });
    const page1 = page1Result.finalPage;
    const page1Attempts = page1Result.attempts;
    const page1Error = classifyPageError(page1);

    // --- Page 2 decision + fetch ---
    // Skip page 2 unless page 1 was a clean 200 that filled its cap AND has
    // a next cursor AND we still need more results AND we still have quota.
    // Each condition maps to a distinct skipReason so auditors can see why.
    let page2 = null;
    let page2Attempts = [];
    let page2Error = null;
    let page2Skipped = false;
    let skipReason = null;
    let cursor = null;
    const page1Results = Array.isArray(page1.payload?.results) ? page1.payload.results : [];
    if (page1Error) {
      page2Skipped = true;
      skipReason = `page1_${page1Error.kind}`;
    } else if (page1Results.length < CL_MAX_PAGE_SIZE) {
      page2Skipped = true;
      skipReason = 'page1_result_count_below_page_size';
    } else if (page1Results.length >= topK) {
      page2Skipped = true;
      skipReason = 'page1_already_has_topk';
    } else {
      cursor = extractCursor(page1.payload?.next);
      if (!cursor) {
        page2Skipped = true;
        skipReason = 'no_next_cursor';
      } else if (limiter.isQuotaExhausted()) {
        page2Skipped = true;
        skipReason = 'quota_exhausted';
      } else {
        const page2Url = buildUrl(endpoint, jurisdictionQuery.query, {
          pageSize,
          courtIds: jurisdictionQuery.courtIds,
          cursor
        });
        const page2Result = await fetchPageWithRetry({
          pageNumber: 2,
          url: page2Url,
          headers,
          cursor,
          requestTimeoutMs,
          fetchFn,
          limiter,
          onLog
        });
        page2 = page2Result.finalPage;
        page2Attempts = page2Result.attempts;
        page2Error = classifyPageError(page2);
      }
    }

    // --- Combine results ---
    // Order: page 1 results (preserving CL's rank), followed by page 2. We
    // never re-rank across pages — CL gave them to us in ranked order.
    // Duplicates by cluster_id are theoretically possible but empirically
    // rare with cursor pagination; if they appear, the scorer's first-hit
    // logic still picks the earlier occurrence.
    const combinedResults = [...page1Results];
    if (page2 && !page2Error) {
      const page2Results = Array.isArray(page2.payload?.results) ? page2.payload.results : [];
      combinedResults.push(...page2Results);
    }
    const totalAvailable = page1.payload?.count ?? combinedResults.length;
    const envelope = normalizeEnvelope(rawQuery, {
      results: combinedResults,
      totalAvailable
    }, { topK });

    // --- Failure classification ---
    // Page 1 error is fatal (nothing to score). Page 2 error is soft — we
    // still return page 1's results and record the page 2 failure in the
    // audit + providerMetadata so scoring proceeds against a partial page.
    const errorObject = page1Error;
    const status = errorObject ? 'provider_failure' : 'completed';

    // --- Audit capture (v2: pages array; retries appear as additional entries
    // with the same `page` number and incrementing `attempt`) ---
    const rawResponseRelPath = `${RAW_RESPONSES_DIR}/${sanitizeCaseIdForFilename(benchmarkCase.caseId)}.json`;
    const auditPages = [...page1Attempts, ...page2Attempts];
    const retryAttempts = auditPages.filter((entry) => entry.attempt > 1).length;
    const auditCapture = {
      schema_version: 'trustfoundry.benchmarks.courtlistener.capture.v2',
      caseId: benchmarkCase.caseId,
      provider: this.id,
      query: rawQuery,
      courtIds: jurisdictionQuery.courtIds,
      topK,
      semantic: true,
      pagination: {
        pagesFetched: (page2 ? 2 : 1),
        page2Skipped,
        skipReason,
        page2Error,
        retryAttempts
      },
      pages: auditPages
    };

    // --- Timing spans both pages ---
    const overallStartedAt = new Date(page1.startedAtMs).toISOString();
    const overallCompletedAtMs = page2 ? page2.completedAtMs : page1.completedAtMs;
    const overallCompletedAt = new Date(overallCompletedAtMs).toISOString();
    const overallDurationMs = overallCompletedAtMs - page1.startedAtMs;
    const totalSleepMs = page1.sleepMs + (page2?.sleepMs ?? 0);

    return {
      caseId: benchmarkCase.caseId,
      status,
      rawOutput: {
        endpoint: page1.url,
        query: rawQuery,
        effectiveQuery: jurisdictionQuery.query,
        request: { query: rawQuery, page_size: pageSize, semantic: true },
        jurisdictionFilter: {
          mode: jurisdictionQuery.mode,
          state: jurisdictionQuery.state ?? null,
          applied: jurisdictionQuery.applied,
          filterQuery: jurisdictionQuery.filterQuery,
          courtParam: jurisdictionQuery.courtParam,
          courtCount: jurisdictionQuery.courtIds.length,
          courtIds: jurisdictionQuery.courtIds
        },
        httpStatus: page1.httpStatus,
        responseCount: page1.payload?.count ?? null,
        retryAfter: page1.retryAfter,
        pagination: {
          pagesFetched: page2 ? 2 : 1,
          page2Skipped,
          skipReason,
          page2HttpStatus: page2?.httpStatus ?? null,
          page2Error,
          retryAttempts
        }
      },
      finalOutputText: JSON.stringify(envelope),
      artifacts: [
        {
          path: rawResponseRelPath,
          content: JSON.stringify(auditCapture, null, 2)
        }
      ],
      providerMetadata: {
        provider: this.id,
        endpoint: page1.url,
        httpStatus: page1.httpStatus,
        totalAvailable: page1.payload?.count ?? null,
        resultsReturned: envelope.results.length,
        topK,
        pageSize,
        semantic: true,
        rateLimitsSource: limiter.source,
        jurisdictionFilter: {
          mode: jurisdictionQuery.mode,
          state: jurisdictionQuery.state ?? null,
          applied: jurisdictionQuery.applied,
          filterQuery: jurisdictionQuery.filterQuery,
          courtParam: jurisdictionQuery.courtParam,
          courtCount: jurisdictionQuery.courtIds.length,
          courtIds: jurisdictionQuery.courtIds
        },
        retryAfter: page1.retryAfter,
        sleepBeforeCallMs: totalSleepMs,
        rawResponsePath: rawResponseRelPath,
        pagesFetched: page2 ? 2 : 1,
        retryAttempts,
        page2Skipped,
        page2SkipReason: skipReason,
        page2Error
      },
      timing: {
        startedAt: overallStartedAt,
        completedAt: overallCompletedAt,
        durationMs: overallDurationMs
      },
      tokenUsage: null,
      retryMetadata: null,
      error: errorObject
    };
  }
};

export const _internals = {
  CL_MAX_PAGE_SIZE,
  DEFAULT_ENDPOINT,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TOP_K,
  DEFAULT_TOKEN_ENV,
  MAX_ATTEMPTS_PER_PAGE,
  MAX_RETRY_AFTER_MS,
  RETRY_ON_STATUS,
  buildJurisdictionFilteredQuery,
  buildUrl,
  classifyPageError,
  effectivePageSize,
  effectiveTopK,
  extractCursor,
  normalizeEnvelope,
  pageAuditEntry,
  prepareJurisdictionFilteredQuery,
  rateLimiterByConfig,
  resolveJurisdictionFilterSettings,
  retryAfterToMs
};
