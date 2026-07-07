/**
 * Anthropic legal-search provider adapter.
 *
 * Sends a benchmark case-question row to the Claude Messages API with the
 * `web_search_20250305` tool enabled and instructs the model to return a
 * JSON envelope of ranked case-law results shaped for the
 * `trustfoundry-legal-search` scorer.
 *
 * Contract: matches the current
 * `@trustfoundry-ai/benchmarks-harness` provider adapter shape
 * (`describe({ config })` + `executeCase({ benchmarkCase, config })`).
 *
 * See `docs/adapters/anthropic-legal-search.md` for the qualitative
 * writeup: this adapter exists to *demonstrate* the retrieval and
 * citation-trust gap between general LLM web-search and legal-specific
 * search, not to compete with either.
 */

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TOP_K = 25;
const DEFAULT_WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';
const DEFAULT_WEB_SEARCH_TOOL_NAME = 'web_search';
const DEFAULT_WEB_SEARCH_MAX_USES = 3;
const MAX_ATTEMPTS = 2;
const PROVIDER_ID = 'anthropic-legal-search';
const PROVIDER_VERSION = 'anthropic-legal-search-provider-v1';

const CASE_MODEL_TYPES = new Set(['case_question', 'case_key_fact']);

function positiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value, fallback = null) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function configuredModel(config = {}) {
  const model = config.model ?? config.model_id ?? config.modelId;
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('anthropic-legal-search requires provider config model');
  }
  return model.trim();
}

function configuredTopK(config = {}) {
  return positiveInteger(config.top_k ?? config.topK ?? config.limit, DEFAULT_TOP_K);
}

function configuredWebSearchMaxUses(config = {}) {
  return positiveInteger(
    config.web_search_max_uses ?? config.webSearchMaxUses,
    DEFAULT_WEB_SEARCH_MAX_USES
  );
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function firstString(...values) {
  for (const value of values.flat()) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values.flatMap(normalizeList)) {
    const key = value.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

function assertCaseRow(benchmarkCase) {
  const metadata = benchmarkCase?.metadata ?? {};
  const docType = metadata.doc_type ?? metadata.docType;
  const modelType = metadata.model_type ?? metadata.modelType;
  if (docType !== 'case' || !CASE_MODEL_TYPES.has(modelType)) {
    throw new Error(
      `anthropic-legal-search only supports case rows; got doc_type=${docType ?? 'unknown'} ` +
        `model_type=${modelType ?? 'unknown'}`
    );
  }
}

function jurisdictionDescription(benchmarkCase) {
  const metadata = benchmarkCase?.metadata ?? {};
  const state =
    metadata.state ??
    metadata.geo_level_2_identifier ??
    metadata.geoLevel2Identifier ??
    null;
  const authority = metadata.authority_identifier ?? metadata.authorityIdentifier ?? null;
  const court = metadata.court_id ?? metadata.courtId ?? null;
  const parts = [];
  if (state) parts.push(`state=${String(state).toUpperCase()}`);
  if (authority) parts.push(`authority=${authority}`);
  if (court && court !== authority) parts.push(`court=${court}`);
  return parts.length ? parts.join(', ') : 'unknown';
}

function buildWebSearchTool(config = {}) {
  const tool = {
    type:
      config.web_search_tool_type ??
      config.webSearchToolType ??
      config.web_search_tool ??
      DEFAULT_WEB_SEARCH_TOOL_TYPE,
    name: config.web_search_tool_name ?? config.webSearchToolName ?? DEFAULT_WEB_SEARCH_TOOL_NAME,
    max_uses: configuredWebSearchMaxUses(config)
  };
  const allowedDomains = normalizeList(config.allowed_domains ?? config.allowedDomains);
  const blockedDomains = normalizeList(config.blocked_domains ?? config.blockedDomains);
  if (allowedDomains.length) tool.allowed_domains = allowedDomains;
  if (blockedDomains.length) tool.blocked_domains = blockedDomains;
  return tool;
}

function pricingSnapshot(config = {}) {
  const pricing = config.pricing;
  if (!pricing || typeof pricing !== 'object') return null;
  return {
    model: pricing.model ?? config.model ?? config.model_id ?? config.modelId ?? null,
    pricing_level: pricing.pricing_level ?? pricing.pricingLevel ?? null,
    source: pricing.source ?? null,
    source_accessed_at: pricing.source_accessed_at ?? pricing.sourceAccessedAt ?? null,
    currency: pricing.currency ?? 'USD',
    unit: pricing.unit ?? 'per_1m_tokens',
    input_per_million_tokens:
      pricing.input_per_million_tokens ?? pricing.inputPerMillionTokens ?? null,
    output_per_million_tokens:
      pricing.output_per_million_tokens ?? pricing.outputPerMillionTokens ?? null
  };
}

function buildSystemPrompt() {
  return [
    'You are a legal search retrieval adapter for a benchmark.',
    'Use web search to find and rank candidate court opinions.',
    'This is a retrieval task, not an answer-generation task.',
    'Treat <target_state> as a hard jurisdiction filter analogous to a state filter in a search API, not as the user\'s physical location.',
    'For a U.S. state abbreviation, rank cases from that state\'s courts first and exclude unrelated jurisdictions unless no plausible in-state authority exists.',
    'For FED, rank federal court cases first.',
    'Prefer official court, CourtListener, Justia, Google Scholar, and other legal-source pages.',
    'Every result must include a Bluebook-style reporter citation when one can be found.',
    'Return only valid JSON with this exact shape:',
    '{"results":[{"rank":1,"title":"","bluebook_citation":"","citations":[],"url":"","publisher":"","date":"","summary":"","relevance":""}]}'
  ].join(' ');
}

function buildUserPrompt(benchmarkCase, { topK }) {
  const metadata = benchmarkCase?.metadata ?? {};
  const targetState =
    metadata.state ??
    metadata.geo_level_2_identifier ??
    metadata.geoLevel2Identifier ??
    null;
  return [
    '<search_task>',
    '  <objective>Return ranked case-law search results for benchmark scoring.</objective>',
    `  <query>${benchmarkCase.prompt ?? ''}</query>`,
    `  <target_state>${targetState ? String(targetState).toUpperCase() : 'FED'}</target_state>`,
    `  <jurisdiction_context>${jurisdictionDescription(benchmarkCase)}</jurisdiction_context>`,
    `  <dataset>${metadata.datasetName ?? 'unknown'}</dataset>`,
    `  <model_type>${metadata.model_type ?? metadata.modelType ?? 'unknown'}</model_type>`,
    `  <result_count>${topK}</result_count>`,
    '  <ranking_rules>',
    '    <rule>Rank likely matching authorities highest.</rule>',
    '    <rule>Apply target_state as the jurisdiction constraint before topical similarity.</rule>',
    '    <rule>Use Bluebook reporter citations such as "13 Mich. 233" or "210 F. App\'x 521".</rule>',
    '    <rule>If multiple citations exist, put the primary Bluebook citation in bluebook_citation and all known citations in citations.</rule>',
    '  </ranking_rules>',
    '  <output_rules>',
    '    <rule>Return only the JSON object.</rule>',
    '    <rule>Do not include markdown fences, explanatory prose, or answer text outside JSON.</rule>',
    '  </output_rules>',
    '</search_task>'
  ].join('\n');
}

function streamingEnabled(config = {}) {
  const value = config.stream ?? config.streaming;
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

function buildRequestBody(benchmarkCase, config = {}) {
  assertCaseRow(benchmarkCase);
  const query = benchmarkCase?.prompt ?? '';
  if (!query.trim()) throw new Error('anthropic-legal-search requires a non-empty case prompt');
  const topK = configuredTopK(config);
  const body = {
    model: configuredModel(config),
    max_tokens: positiveInteger(config.max_tokens ?? config.maxTokens, DEFAULT_MAX_TOKENS),
    system: buildSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(benchmarkCase, { topK })
      }
    ],
    tools: [buildWebSearchTool(config)]
  };
  if (config.temperature !== undefined && config.temperature !== null) {
    body.temperature = finiteNumber(config.temperature);
  }
  if (streamingEnabled(config)) body.stream = true;
  return body;
}

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = /x-api-key|authorization/i.test(name) ? '[REDACTED]' : value;
  }
  return out;
}

function responseTextBlocks(payload) {
  return Array.isArray(payload?.content)
    ? payload.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
    : [];
}

function parseJsonCandidate(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

function extractJsonFromText(text) {
  const direct = parseJsonCandidate(text);
  if (direct) return direct;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const parsed = parseJsonCandidate(fence[1]);
    if (parsed) return parsed;
  }

  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject !== -1 && lastObject > firstObject) {
    const parsed = parseJsonCandidate(text.slice(firstObject, lastObject + 1));
    if (parsed) return parsed;
  }

  const firstArray = text.indexOf('[');
  const lastArray = text.lastIndexOf(']');
  if (firstArray !== -1 && lastArray > firstArray) {
    const parsed = parseJsonCandidate(text.slice(firstArray, lastArray + 1));
    if (parsed) return parsed;
  }

  return null;
}

function findWebSearchToolError(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWebSearchToolError(item);
      if (found) return found;
    }
    return null;
  }
  if (value.type === 'web_search_tool_result_error') {
    return {
      code: value.error_code ?? value.errorCode ?? value.code ?? null,
      message: value.message ?? value.error ?? 'Claude web search tool error'
    };
  }
  if (
    value.type === 'web_search_tool_result' &&
    value.content?.type === 'web_search_tool_result_error'
  ) {
    return {
      code: value.content.error_code ?? value.content.errorCode ?? value.content.code ?? null,
      message: value.content.message ?? value.content.error ?? 'Claude web search tool error'
    };
  }
  for (const item of Object.values(value)) {
    const found = findWebSearchToolError(item);
    if (found) return found;
  }
  return null;
}

function normalizeClaudeResult(result, index) {
  const citations = uniqueStrings([
    result?.citations,
    result?.bluebook_citation,
    result?.bluebookCitation,
    result?.citation,
    result?.primary_citation,
    result?.primaryCitation
  ]);
  const primaryCitation = firstString(
    result?.bluebook_citation,
    result?.bluebookCitation,
    result?.citation,
    result?.primary_citation,
    result?.primaryCitation,
    citations[0]
  );
  return {
    rank: positiveInteger(result?.rank, index + 1),
    title: firstString(result?.title, result?.case_name, result?.caseName),
    citation: primaryCitation,
    citations,
    bluebook_citation: primaryCitation,
    url: firstString(result?.url, result?.source_url, result?.sourceUrl),
    publisher: firstString(result?.publisher, result?.source, result?.source_publisher),
    date: firstString(result?.date, result?.published_date, result?.publishedDate),
    excerpt: firstString(result?.summary, result?.relevance, result?.snippet),
    summary: firstString(result?.summary),
    relevance: firstString(result?.relevance),
    result_type: 'case'
  };
}

function normalizeEnvelope(query, modelOutput, { topK = DEFAULT_TOP_K } = {}) {
  const sourceResults = Array.isArray(modelOutput)
    ? modelOutput
    : Array.isArray(modelOutput?.results)
      ? modelOutput.results
      : Array.isArray(modelOutput?.search_results)
        ? modelOutput.search_results
        : [];
  const results = sourceResults
    .slice(0, topK)
    .map(normalizeClaudeResult)
    .filter((result) => result.title || result.citation || result.url);
  return {
    query,
    total_available: sourceResults.length,
    result_count: results.length,
    results
  };
}

function hasUsableCitation(envelope) {
  return envelope.results.some((result) => result.citation || result.citations.length);
}

function tokenUsageFrom(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
  const cacheCreationInputTokens =
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens =
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    raw: usage
  };
}

function makeFailure(benchmarkCase, kind, message, {
  endpoint = null,
  request = null,
  httpStatus = null,
  startedAtMs = Date.now(),
  completedAtMs = Date.now(),
  rawResponse = null,
  tokenUsage = null
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
    tokenUsage,
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

// Consume Anthropic's SSE stream and accumulate events into a payload
// with the same shape as a non-streaming Messages API response.
// Streaming keeps the connection active — Anthropic's edge closes idle
// non-streaming connections at ~120s when sonnet+web_search hold the
// response open, so streaming is required for reliable long-tool runs.
async function readSseResponse(response) {
  const events = [];
  const partialBlocks = new Map();
  const payload = {
    id: null,
    type: null,
    role: null,
    model: null,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    },
    error: null
  };

  const applyEvent = (eventType, data) => {
    events.push({ event: eventType, data });
    const type = data?.type ?? eventType;
    switch (type) {
      case 'message_start': {
        const m = data.message ?? {};
        payload.id = m.id ?? payload.id;
        payload.type = m.type ?? payload.type;
        payload.role = m.role ?? payload.role;
        payload.model = m.model ?? payload.model;
        const u = m.usage ?? {};
        if (u.input_tokens !== undefined) payload.usage.input_tokens = u.input_tokens;
        if (u.output_tokens !== undefined) payload.usage.output_tokens = u.output_tokens;
        if (u.cache_creation_input_tokens !== undefined) {
          payload.usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        }
        if (u.cache_read_input_tokens !== undefined) {
          payload.usage.cache_read_input_tokens = u.cache_read_input_tokens;
        }
        break;
      }
      case 'content_block_start': {
        const block = { ...(data.content_block ?? {}) };
        if (block.type === 'text' && block.text === undefined) block.text = '';
        if (block.type === 'thinking' && block.thinking === undefined) block.thinking = '';
        if (block.type === 'server_tool_use') block.partial_json = '';
        partialBlocks.set(data.index, block);
        break;
      }
      case 'content_block_delta': {
        const block = partialBlocks.get(data.index);
        if (!block) break;
        const delta = data.delta ?? {};
        if (delta.type === 'text_delta') {
          block.text = (block.text ?? '') + (delta.text ?? '');
        } else if (delta.type === 'thinking_delta') {
          block.thinking = (block.thinking ?? '') + (delta.thinking ?? '');
        } else if (delta.type === 'input_json_delta') {
          block.partial_json = (block.partial_json ?? '') + (delta.partial_json ?? '');
        }
        break;
      }
      case 'content_block_stop': {
        const block = partialBlocks.get(data.index);
        if (block) {
          if (block.type === 'server_tool_use' && typeof block.partial_json === 'string') {
            try {
              block.input = JSON.parse(block.partial_json);
            } catch {
              // leave input undefined; downstream inspection ignores it
            }
            delete block.partial_json;
          }
          payload.content.push(block);
          partialBlocks.delete(data.index);
        }
        break;
      }
      case 'message_delta': {
        const delta = data.delta ?? {};
        if (delta.stop_reason !== undefined) payload.stop_reason = delta.stop_reason;
        if (delta.stop_sequence !== undefined) payload.stop_sequence = delta.stop_sequence;
        const u = data.usage ?? {};
        if (u.output_tokens !== undefined) payload.usage.output_tokens = u.output_tokens;
        if (u.cache_creation_input_tokens !== undefined) {
          payload.usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        }
        if (u.cache_read_input_tokens !== undefined) {
          payload.usage.cache_read_input_tokens = u.cache_read_input_tokens;
        }
        break;
      }
      case 'error': {
        payload.error = data.error ?? { type: 'error', message: 'Unknown SSE error' };
        break;
      }
      case 'message_stop':
      case 'ping':
      default:
        break;
    }
  };

  const parseEventBlock = (raw) => {
    let eventType = null;
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!dataLines.length) return;
    const dataText = dataLines.join('\n');
    let data;
    try {
      data = JSON.parse(dataText);
    } catch {
      return;
    }
    applyEvent(eventType, data);
  };

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    for (const raw of text.split('\n\n')) {
      const trimmed = raw.trim();
      if (trimmed) parseEventBlock(trimmed);
    }
    return { events, payload };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep).trim();
      buffer = buffer.slice(sep + 2);
      if (raw) parseEventBlock(raw);
    }
  }
  const tail = decoder.decode();
  buffer += tail;
  for (const raw of buffer.split('\n\n')) {
    const trimmed = raw.trim();
    if (trimmed) parseEventBlock(trimmed);
  }
  return { events, payload };
}

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
  let responseText = null;
  let responseJson = null;
  let sseEventCount = null;
  let sseError = null;
  let fetchError = null;
  let responseParseError = null;

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    httpStatus = response.status;
    const contentType = response.headers?.get?.('content-type') ?? '';
    const isSse = contentType.includes('text/event-stream');
    if (isSse && response.ok) {
      try {
        const { events, payload } = await readSseResponse(response);
        sseEventCount = events.length;
        responseJson = payload;
        if (payload.error) {
          sseError = payload.error;
        }
      } catch (caught) {
        responseParseError = caught instanceof Error ? caught.message : String(caught);
      }
    } else {
      responseText = await response.text();
      try {
        responseJson = responseText ? JSON.parse(responseText) : null;
      } catch (caught) {
        responseParseError = caught instanceof Error ? caught.message : String(caught);
      }
    }
  } catch (caught) {
    fetchError = caught instanceof Error ? caught.message : String(caught);
  }

  const completedAtMs = Date.now();
  const redactedRequest = {
    method: 'POST',
    headers: redactHeaders(headers),
    body: request
  };
  const usage = tokenUsageFrom(responseJson);

  if (fetchError) {
    return makeFailure(benchmarkCase, 'fetch_error', fetchError, {
      endpoint,
      request: redactedRequest,
      httpStatus,
      startedAtMs,
      completedAtMs
    });
  }

  if (httpStatus < 200 || httpStatus > 299) {
    return makeFailure(
      benchmarkCase,
      'http_error',
      httpErrorMessage(responseJson, responseText, httpStatus),
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson ?? responseText,
        tokenUsage: usage
      }
    );
  }

  if (responseParseError) {
    return makeFailure(
      benchmarkCase,
      'parse_error',
      `Failed to parse Anthropic response JSON: ${responseParseError}`,
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseText
      }
    );
  }

  if (sseError) {
    const message = sseError.message ?? sseError.error ?? 'Anthropic SSE error event';
    return makeFailure(
      benchmarkCase,
      'stream_error',
      sseError.type ? `${sseError.type}: ${message}` : message,
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage
      }
    );
  }

  const toolError = findWebSearchToolError(responseJson);
  if (toolError) {
    return makeFailure(
      benchmarkCase,
      'tool_error',
      toolError.code ? `${toolError.code}: ${toolError.message}` : toolError.message,
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage
      }
    );
  }

  const text = responseTextBlocks(responseJson).join('\n').trim();
  const modelOutput = extractJsonFromText(text);
  if (!modelOutput) {
    return makeFailure(
      benchmarkCase,
      'parse_error',
      'Claude response text did not contain parseable JSON results',
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage
      }
    );
  }

  const envelope = normalizeEnvelope(benchmarkCase.prompt ?? '', modelOutput, { topK });
  const missingMessage =
    envelope.results.length === 0
      ? 'Claude JSON output did not include any results'
      : !hasUsableCitation(envelope)
        ? 'Claude JSON output did not include any usable citations'
        : null;
  if (missingMessage) {
    return {
      ...makeFailure(benchmarkCase, 'missing_results', missingMessage, {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage
      }),
      rawOutput: {
        endpoint,
        request: redactedRequest,
        httpStatus,
        response: responseJson,
        text,
        normalizedResults: envelope.results,
        error: { kind: 'missing_results', message: missingMessage }
      },
      finalOutputText: JSON.stringify(envelope),
      providerMetadata: {
        provider: PROVIDER_ID,
        endpoint,
        httpStatus,
        model: request.model,
        topK,
        resultCount: envelope.result_count,
        error: 'missing_results'
      },
      tokenUsage: usage
    };
  }

  return {
    caseId: benchmarkCase.caseId,
    status: 'completed',
    rawOutput: {
      endpoint,
      request: redactedRequest,
      httpStatus,
      response: responseJson,
      text,
      normalizedResults: envelope.results,
      sseEventCount
    },
    finalOutputText: JSON.stringify(envelope),
    artifacts: [],
    providerMetadata: {
      provider: PROVIDER_ID,
      endpoint,
      httpStatus,
      model: request.model,
      topK,
      streaming: Boolean(request.stream),
      sseEventCount,
      webSearchToolType: request.tools?.[0]?.type ?? null,
      webSearchMaxUses: request.tools?.[0]?.max_uses ?? null,
      resultCount: envelope.result_count,
      totalAvailable: envelope.total_available
    },
    timing: {
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      serverResponseDurationMs: null
    },
    tokenUsage: usage,
    retryMetadata: null,
    error: null
  };
}

function isRetryableProviderFailure(result) {
  if (result?.status !== 'provider_failure') return false;
  const kind = result.error?.kind;
  const status = result.error?.status ?? result.providerMetadata?.httpStatus ?? null;
  if (kind === 'fetch_error' || kind === 'stream_error') return true;
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

export const anthropicLegalSearchProviderAdapter = {
  id: PROVIDER_ID,
  version: PROVIDER_VERSION,

  async describe({ config = {} }) {
    return {
      id: this.id,
      version: this.version,
      subject: 'case-law-web-search',
      target: config.endpoint ?? DEFAULT_ENDPOINT,
      apiKeyEnv: config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      settings: {
        model: config.model ?? config.model_id ?? config.modelId ?? null,
        requestTimeoutMs: config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
        anthropicVersion: config.anthropic_version ?? DEFAULT_ANTHROPIC_VERSION,
        topK: configuredTopK(config),
        maxTokens: positiveInteger(config.max_tokens ?? config.maxTokens, DEFAULT_MAX_TOKENS),
        temperature: config.temperature === undefined ? null : finiteNumber(config.temperature),
        pricing: pricingSnapshot(config),
        webSearchTool: buildWebSearchTool(config),
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
      const kind = message.includes('provider config model') ? 'config_error' : 'validation_error';
      return makeFailure(benchmarkCase, kind, message, { endpoint });
    }

    const apiKeyEnv = config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      return makeFailure(benchmarkCase, 'config_error', `Missing env ${apiKeyEnv}`, {
        endpoint,
        request
      });
    }

    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': config.anthropic_version ?? DEFAULT_ANTHROPIC_VERSION,
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
        request,
        headers,
        requestTimeoutMs,
        topK,
        fetchFn
      });
      attempts.push(attemptSummary(result, attempt));
      if (!isRetryableProviderFailure(result)) break;
    }
    return withRetryMetadata(result, attempts);
  }
};

export const _internals = {
  buildRequestBody,
  buildSystemPrompt,
  buildUserPrompt,
  buildWebSearchTool,
  configuredModel,
  configuredTopK,
  extractJsonFromText,
  findWebSearchToolError,
  hasUsableCitation,
  isRetryableProviderFailure,
  jurisdictionDescription,
  normalizeClaudeResult,
  normalizeEnvelope,
  pricingSnapshot,
  readSseResponse,
  responseTextBlocks,
  streamingEnabled
};
