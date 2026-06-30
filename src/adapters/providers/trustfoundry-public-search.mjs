const DEFAULT_ENDPOINT = 'https://api.trustfoundry.ai/public/v1/search';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_API_KEY_ENV = 'TF_API_KEY';
const MAX_ATTEMPTS = 2;
const PROVIDER_ID = 'trustfoundry-public-search';

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function configuredBool(config, snakeKey, camelKey, fallback = false) {
  const value = config[snakeKey] ?? config[camelKey];
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function configuredModelType(config = {}, benchmarkCase = null) {
  const modelType =
    config.model_type ??
    config.modelType ??
    benchmarkCase?.metadata?.model_type ??
    benchmarkCase?.metadata?.modelType;
  if (typeof modelType !== 'string' || !modelType.trim()) {
    throw new Error(
      'trustfoundry-public-search requires provider config model_type or row metadata.model_type'
    );
  }
  return modelType.trim();
}

function configuredSubject(config = {}) {
  const modelType = config.model_type ?? config.modelType;
  return typeof modelType === 'string' && modelType.trim() ? modelType.trim() : 'per-row';
}

function normalizeState(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'US' || normalized === 'USA' || normalized === 'FEDERAL') return 'FED';
  return normalized;
}

function stateForCase(benchmarkCase) {
  const metadata = benchmarkCase?.metadata ?? {};
  const expected = metadata.expected ?? {};
  return normalizeState(
    metadata.geo_level_2_identifier ??
      expected.state ??
      metadata.state
  );
}

function maxResultsForConfig(config = {}) {
  return positiveInteger(config.max_results ?? config.maxResults ?? config.top_k ?? config.topK);
}

function requestLimitForConfig(config = {}) {
  return positiveInteger(config.limit ?? config.requestLimit ?? config.request_limit);
}

function buildRequestBody(benchmarkCase, config = {}) {
  const body = {
    query: benchmarkCase.prompt ?? '',
    model_type: configuredModelType(config, benchmarkCase)
  };
  const stateFilterEnabled = configuredBool(
    config,
    'state_filter_enabled',
    'stateFilterEnabled',
    true
  );
  if (stateFilterEnabled) {
    const state = stateForCase(benchmarkCase);
    if (!state) {
      throw new Error(
        `state_filter_enabled=true but case ${benchmarkCase.caseId} has no usable state`
      );
    }
    body.state = state;
  }
  const limit = requestLimitForConfig(config);
  if (limit !== null) body.limit = limit;
  return body;
}

function parseNdjsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function appendCompleteNdjsonLines(text, events, onEvent) {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    const event = parseNdjsonLine(line);
    if (!event) continue;
    events.push(event);
    onEvent?.(event);
  }
  return remainder;
}

async function readNdjsonResponse(response, { now = () => Date.now() } = {}) {
  const events = [];
  let rawText = '';
  let firstByteAtMs = null;
  let citationsReadyAtMs = null;
  const markEvent = (event) => {
    if (event?.type === 'citations_ready' && citationsReadyAtMs === null) {
      citationsReadyAtMs = now();
    }
  };

  if (!response.body || typeof response.body.getReader !== 'function') {
    rawText = await response.text();
    const streamCompletedAtMs = now();
    for (const line of rawText.split(/\r?\n/)) {
      const event = parseNdjsonLine(line);
      if (!event) continue;
      events.push(event);
      if (event?.type === 'citations_ready' && citationsReadyAtMs === null) {
        citationsReadyAtMs = streamCompletedAtMs;
      }
    }
    return { events, rawText, firstByteAtMs, citationsReadyAtMs, streamCompletedAtMs };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    if (firstByteAtMs === null) firstByteAtMs = now();
    rawText += chunk;
    pending = appendCompleteNdjsonLines(`${pending}${chunk}`, events, markEvent);
  }
  const tail = decoder.decode();
  if (tail) {
    if (firstByteAtMs === null) firstByteAtMs = now();
    rawText += tail;
    pending = appendCompleteNdjsonLines(`${pending}${tail}`, events, markEvent);
  }
  const tailEvent = parseNdjsonLine(pending);
  if (tailEvent) {
    events.push(tailEvent);
    markEvent(tailEvent);
  }
  return { events, rawText, firstByteAtMs, citationsReadyAtMs, streamCompletedAtMs: now() };
}

function extractSearchSet(events) {
  for (const event of events) {
    if (event?.type !== 'citations_ready') continue;
    let content = event.content;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        return null;
      }
    }
    if (content && Array.isArray(content.search_results)) return content;
  }
  return null;
}

function findErrorEvent(events) {
  return events.find((event) => event?.type === 'error') ?? null;
}

function resultErrorMessage(event) {
  if (!event) return null;
  const content = event.content;
  if (typeof content === 'string') return content;
  if (content?.message) return String(content.message);
  return JSON.stringify(content ?? event);
}

function parseJsonError(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    return parsed?.error ?? parsed?.detail ?? parsed?.message ?? null;
  } catch {
    return null;
  }
}

function normalizeResult(result, index) {
  return {
    rank: index + 1,
    uuid: result.uuid ?? null,
    document_uuid: result.document_uuid ?? result.documentUuid ?? null,
    doc_id: result.document_uuid ?? result.documentUuid ?? null,
    title: result.header ?? result.title ?? null,
    header: result.header ?? null,
    citation: result.citation ?? null,
    citations: result.citation ? [result.citation] : [],
    citation_tag: result.citation_tag ?? result.citationTag ?? null,
    url: result.url ?? null,
    excerpt: result.excerpt ?? null,
    relevance_score: result.relevance_score ?? result.relevanceScore ?? null,
    native_score: result.relevance_score ?? result.relevanceScore ?? null,
    result_type: result.result_type ?? result.resultType ?? null,
    first_level_geo: result.first_level_geo ?? result.firstLevelGeo ?? null,
    second_level_geo: result.second_level_geo ?? result.secondLevelGeo ?? null,
    court_id: result.court_id ?? result.courtId ?? null,
    court_name: result.court_name ?? result.courtName ?? null,
    published_date: result.published_date ?? result.publishedDate ?? null,
    created_at: result.created_at ?? result.createdAt ?? null
  };
}

function normalizeEnvelope(query, searchSet, { maxResults = null } = {}) {
  const allResults = Array.isArray(searchSet?.search_results) ? searchSet.search_results : [];
  const selected = Number.isInteger(maxResults) ? allResults.slice(0, maxResults) : allResults;
  return {
    query,
    set_uuid: searchSet?.uuid ?? null,
    title: searchSet?.title ?? null,
    created_at: searchSet?.created_at ?? null,
    total_available: allResults.length,
    result_count: selected.length,
    results: selected.map(normalizeResult)
  };
}

function makeFailure(benchmarkCase, kind, message, { request = null, endpoint = null } = {}) {
  const now = new Date().toISOString();
  return {
    caseId: benchmarkCase.caseId,
    status: 'provider_failure',
    rawOutput: { endpoint, request, error: { kind, message } },
    finalOutputText: JSON.stringify({ query: benchmarkCase.prompt ?? '', results: [], result_count: 0 }),
    artifacts: [],
    providerMetadata: {
      provider: PROVIDER_ID,
      endpoint,
      error: kind,
      resultCount: 0
    },
    timing: { startedAt: now, completedAt: now, durationMs: 0 },
    tokenUsage: null,
    retryMetadata: null,
    error: { kind, message }
  };
}

function failureMessage({ httpStatus, httpOk, fetchError, errorEvent, rawText, searchSet }) {
  if (fetchError) return fetchError;
  const eventMessage = resultErrorMessage(errorEvent);
  if (eventMessage) return eventMessage;
  if (searchSet?.error) return String(searchSet.error);
  const jsonError = rawText ? parseJsonError(rawText) : null;
  if (jsonError) return String(jsonError);
  if (!httpOk) return `HTTP ${httpStatus}`;
  if (!searchSet) return 'Response did not include a citations_ready SearchSet event';
  return null;
}

function errorKind({ fetchError, errorEvent, httpOk }) {
  if (fetchError) return 'fetch_error';
  if (errorEvent) return 'stream_error';
  return httpOk ? 'missing_results' : 'http_error';
}

function isRetryableProviderFailure(result) {
  if (result?.status !== 'provider_failure') return false;
  const kind = result.error?.kind;
  const status = result.error?.status ?? result.providerMetadata?.httpStatus ?? null;
  if (kind === 'fetch_error' || kind === 'stream_error' || kind === 'missing_results') {
    return true;
  }
  return kind === 'http_error' && Number.isInteger(status) && status >= 500 && status <= 599;
}

function attemptSummary(result, attempt) {
  return {
    attempt,
    status: result.status,
    error: result.error ?? null,
    httpStatus: result.providerMetadata?.httpStatus ?? result.rawOutput?.httpStatus ?? null,
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
      resultsReadyDurationMs: durationMs,
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

async function executeAttempt({ benchmarkCase, endpoint, request, apiKey, requestTimeoutMs, maxResults }) {
  const startedAtMs = Date.now();
  let httpStatus = null;
  let httpOk = false;
  let stream = {
    events: [],
    rawText: '',
    firstByteAtMs: null,
    citationsReadyAtMs: null,
    streamCompletedAtMs: null
  };
  let fetchError = null;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson'
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    httpStatus = response.status;
    httpOk = response.ok;
    stream = await readNdjsonResponse(response);
  } catch (caught) {
    fetchError = caught instanceof Error ? caught.message : String(caught);
  }

  const streamCompletedAtMs = stream.streamCompletedAtMs ?? Date.now();
  const resultsReadyAtMs = stream.citationsReadyAtMs ?? streamCompletedAtMs;
  const ttfbMs = stream.firstByteAtMs === null ? null : stream.firstByteAtMs - startedAtMs;
  const resultsReadyDurationMs = resultsReadyAtMs - startedAtMs;
  const streamDurationMs = streamCompletedAtMs - startedAtMs;
  const searchSet = extractSearchSet(stream.events);
  const errorEvent = findErrorEvent(stream.events);
  const envelope = normalizeEnvelope(request.query, searchSet, { maxResults });
  const message = failureMessage({
    httpStatus,
    httpOk,
    fetchError,
    errorEvent,
    rawText: stream.rawText,
    searchSet
  });
  const status = message ? 'provider_failure' : 'completed';
  const kind = message ? errorKind({ fetchError, errorEvent, httpOk }) : null;

  return {
    caseId: benchmarkCase.caseId,
    status,
    rawOutput: {
      endpoint,
      request,
      httpStatus,
      httpOk,
      eventCount: stream.events.length,
      events: stream.events,
      searchSet,
      normalizedResults: envelope.results,
      ttfbMs,
      resultsReadyDurationMs,
      streamDurationMs
    },
    finalOutputText: JSON.stringify(envelope),
    artifacts: [],
    providerMetadata: {
      provider: PROVIDER_ID,
      endpoint,
      httpStatus,
      modelType: request.model_type,
      stateFilterEnabled: Object.hasOwn(request, 'state'),
      state: request.state ?? null,
      eventCount: stream.events.length,
      maxResults,
      requestLimit: request.limit ?? null,
      resultCount: envelope.result_count,
      totalAvailable: envelope.total_available,
      ttfbMs,
      resultsReadyDurationMs,
      streamDurationMs,
      citationsReadyObserved: stream.citationsReadyAtMs !== null
    },
    timing: {
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(resultsReadyAtMs).toISOString(),
      durationMs: resultsReadyDurationMs,
      resultsReadyAt: new Date(resultsReadyAtMs).toISOString(),
      resultsReadyDurationMs,
      streamCompletedAt: new Date(streamCompletedAtMs).toISOString(),
      streamDurationMs,
      firstByteAt: stream.firstByteAtMs === null ? null : new Date(stream.firstByteAtMs).toISOString(),
      ttfbMs
    },
    tokenUsage: null,
    retryMetadata: null,
    error: message
      ? {
          kind,
          message,
          status: httpStatus
        }
      : null
  };
}

export const trustfoundryPublicSearchProviderAdapter = {
  id: 'trustfoundry-public-search',
  version: 'trustfoundry-public-search-provider-v1',

  async describe({ config = {} }) {
    const modelType = configuredSubject(config);
    return {
      id: this.id,
      version: this.version,
      subject: modelType,
      target: config.endpoint ?? DEFAULT_ENDPOINT,
      apiKeyEnv: config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      settings: {
        requestTimeoutMs: config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
        modelType,
        stateFilterEnabled: configuredBool(config, 'state_filter_enabled', 'stateFilterEnabled', true),
        maxResults: maxResultsForConfig(config),
        limit: requestLimitForConfig(config)
      }
    };
  },

  async executeCase({ benchmarkCase, config = {} }) {
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    let request;
    try {
      request = buildRequestBody(benchmarkCase, config);
    } catch (error) {
      return makeFailure(
        benchmarkCase,
        'validation_error',
        error instanceof Error ? error.message : String(error),
        { endpoint }
      );
    }

    const apiKeyEnv = config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) return makeFailure(benchmarkCase, 'config_error', `Missing env ${apiKeyEnv}`, { endpoint, request });

    const requestTimeoutMs = config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const maxResults = maxResultsForConfig(config);
    const attempts = [];
    let result = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      result = await executeAttempt({
        benchmarkCase,
        endpoint,
        request,
        apiKey,
        requestTimeoutMs,
        maxResults
      });
      attempts.push(attemptSummary(result, attempt));
      if (!isRetryableProviderFailure(result)) break;
    }
    return withRetryMetadata(result, attempts);
  }
};

export const _internals = {
  buildRequestBody,
  configuredModelType,
  extractSearchSet,
  normalizeEnvelope,
  normalizeState,
  readNdjsonResponse,
  requestLimitForConfig,
  isRetryableProviderFailure,
  stateForCase
};
