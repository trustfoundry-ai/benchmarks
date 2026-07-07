/**
 * OpenAI legal-search provider adapter.
 *
 * Sends a benchmark case-question row to the OpenAI Responses API with the
 * built-in `web_search` tool enabled and constrains the reply to a
 * JSON-schema envelope of ranked case-law results shaped for the
 * `trustfoundry-legal-search` scorer. Sibling of the Anthropic adapter;
 * same public contract (`describe` + `executeCase`), same envelope shape,
 * same failure taxonomy, same 2-attempt retry on transient errors.
 *
 * The web_search tool has no per-call `max_uses` on OpenAI (unlike
 * Anthropic). We deliberately do NOT invent a soft-hint cap — provider
 * metadata records `webSearchBudget: 'unbounded'` so the reproducibility
 * manifest reflects reality.
 *
 * Structured outputs (`text.format` with `type: 'json_schema'`,
 * `strict: true`) guarantees the response text parses to our envelope
 * shape. We still fall back through `extractJsonFromText` defensively,
 * matching the Anthropic adapter, in case a refusal path returns
 * plain text.
 */

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TOP_K = 25;
const DEFAULT_WEB_SEARCH_TOOL_TYPE = 'web_search';
const DEFAULT_SEARCH_TOOL_KIND = 'native';
const DEFAULT_MCP_REQUIRE_APPROVAL = 'never';
const MAX_ATTEMPTS = 2;
const PROVIDER_ID = 'openai-legal-search';
const PROVIDER_VERSION = 'openai-legal-search-provider-v1';

const CASE_MODEL_TYPES = new Set(['case_question', 'case_key_fact']);

function positiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// AbortSignal.timeout throws a TimeoutError on Node 20+, AbortError on
// older Node/undici. Some polyfills stringify the message but leave name
// undefined, so we also fall back to the canonical message.
function isAbortError(err) {
  if (!err) return false;
  const name = err.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return /operation was aborted|timed out|timeout/i.test(message);
}

function finiteNumber(value, fallback = null) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function configuredModel(config = {}) {
  const model = config.model ?? config.model_id ?? config.modelId;
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('openai-legal-search requires provider config model');
  }
  return model.trim();
}

function configuredTopK(config = {}) {
  return positiveInteger(config.top_k ?? config.topK ?? config.limit, DEFAULT_TOP_K);
}

function configuredMaxOutputTokens(config = {}) {
  return positiveInteger(
    config.max_output_tokens ?? config.maxOutputTokens ?? config.max_tokens ?? config.maxTokens,
    DEFAULT_MAX_OUTPUT_TOKENS
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
      `openai-legal-search only supports case rows; got doc_type=${docType ?? 'unknown'} ` +
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

function buildNativeWebSearchTool(config = {}) {
  const type =
    config.web_search_tool_type ??
    config.webSearchToolType ??
    config.web_search_tool ??
    DEFAULT_WEB_SEARCH_TOOL_TYPE;
  const tool = { type };
  const allowedDomains = normalizeList(config.allowed_domains ?? config.allowedDomains);
  const blockedDomains = normalizeList(config.blocked_domains ?? config.blockedDomains);
  if (allowedDomains.length) tool.filters = { ...(tool.filters ?? {}), allowed_domains: allowedDomains };
  if (blockedDomains.length) tool.filters = { ...(tool.filters ?? {}), blocked_domains: blockedDomains };
  return tool;
}

// Env vars are NOT resolved here — that would break describe() when the MCP
// vendor's key isn't in the harness environment yet. resolveMcpAuth() below
// does the substitution just before we ship the request in executeAttempt.
function buildMcpToolTemplate(config = {}) {
  const st = config.search_tool ?? {};
  const serverLabel = firstString(st.server_label, st.serverLabel);
  const serverUrl = firstString(st.server_url, st.serverUrl);
  if (!serverLabel) throw new Error("openai-legal-search search_tool.kind='mcp' requires server_label");
  if (!serverUrl) throw new Error("openai-legal-search search_tool.kind='mcp' requires server_url");
  const tool = {
    type: 'mcp',
    server_label: serverLabel,
    server_url: serverUrl,
    require_approval: st.require_approval ?? st.requireApproval ?? DEFAULT_MCP_REQUIRE_APPROVAL
  };
  const allowedTools = normalizeList(st.allowed_tools ?? st.allowedTools);
  if (allowedTools.length) tool.allowed_tools = allowedTools;
  return tool;
}

function buildToolConfig(config = {}) {
  const kind = config.search_tool?.kind ?? DEFAULT_SEARCH_TOOL_KIND;
  if (kind === 'native') return buildNativeWebSearchTool(config);
  if (kind === 'mcp') return buildMcpToolTemplate(config);
  throw new Error(`openai-legal-search unknown search_tool.kind='${kind}' (expected 'native' or 'mcp')`);
}

// Per-server token cache. Keyed by MCP server URL so a future run against
// multiple MCP servers in one process doesn't collide. Value shape:
//   { token, expiresAtMs, refreshInflight }
// `refreshInflight` is a shared promise so parallel=N workers coalesce onto
// a single refresh instead of stampeding the token endpoint.
const _mcpAuthState = new Map();

function _mcpCacheKey(config) {
  return firstString(config.search_tool?.server_url, config.search_tool?.serverUrl) ?? '';
}

// Test helper — reset cached tokens between test cases.
function _resetMcpAuthState() {
  _mcpAuthState.clear();
}

async function performOAuthRefresh(refreshConfig) {
  const tokenEndpoint =
    firstString(refreshConfig.token_endpoint, refreshConfig.tokenEndpoint) ||
    (firstString(refreshConfig.token_endpoint_env, refreshConfig.tokenEndpointEnv)
      ? process.env[firstString(refreshConfig.token_endpoint_env, refreshConfig.tokenEndpointEnv)]
      : null);
  const refreshTokenEnv = firstString(refreshConfig.refresh_token_env, refreshConfig.refreshTokenEnv);
  const clientIdEnv = firstString(refreshConfig.client_id_env, refreshConfig.clientIdEnv);
  const refreshToken = refreshTokenEnv ? process.env[refreshTokenEnv] : null;
  const clientId = clientIdEnv ? process.env[clientIdEnv] : null;
  if (!tokenEndpoint) throw new Error('OAuth refresh requires token_endpoint (or token_endpoint_env)');
  if (!refreshToken) throw new Error(`OAuth refresh requires env ${refreshTokenEnv} to be set`);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  if (clientId) body.set('client_id', clientId);
  const fetchFn = refreshConfig._fetch ?? globalThis.fetch;
  const r = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`OAuth refresh failed (HTTP ${r.status}): ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error(`OAuth refresh returned no access_token: ${text.slice(0, 300)}`);
  // Rotate the refresh token in-process if the server issued a new one so
  // subsequent refreshes use the current credential.
  if (data.refresh_token && refreshTokenEnv) process.env[refreshTokenEnv] = data.refresh_token;
  return data;
}

// Resolves the auth block into an OpenAI-ready `headers` map. Async because
// it may perform an OAuth refresh when the current access token is near
// expiry. Returns:
//   { ok: true, headers }   — headers may be {} for anonymous MCP endpoints.
//   { ok: false, envName }  — the configured env var is unset.
async function resolveMcpAuth(config = {}) {
  const st = config.search_tool ?? {};
  const auth = st.auth;
  if (!auth) return { ok: true, headers: {} };
  const envName = firstString(auth.api_key_env, auth.apiKeyEnv);
  if (!envName) return { ok: true, headers: {} };

  const refreshConfig = auth.refresh;
  const headerName = firstString(auth.header) ?? 'Authorization';
  const scheme = firstString(auth.scheme) ?? '';
  const now = Date.now();

  // No-refresh path — static bearer. Never touches the token endpoint.
  if (!refreshConfig) {
    const value = process.env[envName];
    if (!value) return { ok: false, envName };
    return { ok: true, headers: { [headerName]: scheme ? `${scheme} ${value}` : value } };
  }

  // Refreshable path — cache the token per server_url, refresh before expiry.
  const cacheKey = _mcpCacheKey(config);
  let entry = _mcpAuthState.get(cacheKey);
  if (!entry) {
    const initialToken = process.env[envName];
    if (!initialToken) return { ok: false, envName };
    // TF's OAuth flow writes an epoch-seconds `expires_at` env var. Fall
    // back to now+3600 if the seed value isn't present.
    const expiresAtEnvName = firstString(refreshConfig.expires_at_env, refreshConfig.expiresAtEnv);
    const expEnvVal = expiresAtEnvName ? process.env[expiresAtEnvName] : null;
    const seededExpiresAtMs = expEnvVal
      ? Number.parseInt(expEnvVal, 10) * 1000
      : now + 3600 * 1000;
    entry = { token: initialToken, expiresAtMs: seededExpiresAtMs, refreshInflight: null };
    _mcpAuthState.set(cacheKey, entry);
  }

  const bufferSeconds = positiveInteger(
    refreshConfig.refresh_before_seconds ?? refreshConfig.refreshBeforeSeconds,
    300
  );
  const bufferMs = bufferSeconds * 1000;
  if (entry.expiresAtMs - now < bufferMs) {
    if (!entry.refreshInflight) {
      const configWithFetch = { ...refreshConfig, _fetch: config._refreshFetch ?? config._fetch };
      entry.refreshInflight = performOAuthRefresh(configWithFetch)
        .then((data) => {
          entry.token = data.access_token;
          entry.expiresAtMs = Date.now() + (positiveInteger(data.expires_in, 3600) * 1000);
          return data;
        })
        .finally(() => {
          entry.refreshInflight = null;
        });
    }
    try {
      await entry.refreshInflight;
    } catch (err) {
      return { ok: false, envName, refreshError: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    ok: true,
    headers: { [headerName]: scheme ? `${scheme} ${entry.token}` : entry.token }
  };
}

function searchBackendLabel(config = {}) {
  const kind = config.search_tool?.kind ?? DEFAULT_SEARCH_TOOL_KIND;
  if (kind === 'mcp') {
    const label = firstString(config.search_tool?.server_label, config.search_tool?.serverLabel) ?? 'mcp';
    return `mcp:${label}`;
  }
  return 'openai-native-web-search';
}

function mcpProviderMetadata(config = {}, responseJson = null, sseEvents = null) {
  if ((config.search_tool?.kind ?? DEFAULT_SEARCH_TOOL_KIND) !== 'mcp') return null;
  const st = config.search_tool ?? {};
  const { calls, gapsMs } = extractMcpCallTimings(sseEvents);
  const completedDurations = calls
    .filter((c) => c.status === 'completed' && Number.isFinite(c.durationMs))
    .map((c) => c.durationMs);
  const failedDurations = calls
    .filter((c) => c.status === 'failed' && Number.isFinite(c.durationMs))
    .map((c) => c.durationMs);
  return {
    serverLabel: firstString(st.server_label, st.serverLabel) ?? null,
    serverUrl: firstString(st.server_url, st.serverUrl) ?? null,
    listedTools: extractListedTools(responseJson),
    callCount: countMcpCalls(responseJson),
    failedCallCount: countFailedMcpCalls(responseJson),
    allowedToolsFilter: normalizeList(st.allowed_tools ?? st.allowedTools),
    requireApproval: st.require_approval ?? st.requireApproval ?? DEFAULT_MCP_REQUIRE_APPROVAL,
    authHeader: firstString(st.auth?.header) ?? (st.auth?.api_key_env || st.auth?.apiKeyEnv ? 'Authorization' : null),
    authEnvVar: firstString(st.auth?.api_key_env, st.auth?.apiKeyEnv) ?? null,
    pricing: mcpPricingSnapshot(config),
    // Per-call timings from SSE event timestamps. `calls[]` is authoritative
    // for backend-log correlation (each entry gives startTsMs / endTsMs /
    // durationMs so ops can find matching TF rows). `callDurations` and
    // `interCallGaps` summaries decompose total wall time into MCP roundtrip
    // vs OpenAI-reasoning latency.
    calls,
    callDurations: summarizeDurations(completedDurations),
    failedCallDurations: summarizeDurations(failedDurations),
    interCallGaps: summarizeDurations(gapsMs)
  };
}

// Count completed mcp_call output items — one per invocation of an MCP-hosted
// tool. Enables per-row cost estimation as callCount * mcp_pricing.per_query
// at report time. OpenAI doesn't itemize MCP vendor billing, so this number
// must be reconciled against the vendor's dashboard for the run window.
function countMcpCalls(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  let count = 0;
  for (const item of output) {
    if (item?.type === 'mcp_call' && item.status === 'completed') count += 1;
  }
  return count;
}

// Vendor-declared MCP pricing. Snapshotted into providerMetadata at run time
// so the run bundle is self-contained. Report-time cost is
// callCount * per_query; anything else (tiered billing, monthly caps) has to
// be reconciled manually against the vendor dashboard.
function mcpPricingSnapshot(config = {}) {
  const pricing = config.mcp_pricing ?? config.mcpPricing;
  if (!pricing || typeof pricing !== 'object') return null;
  return {
    vendor: pricing.vendor ?? null,
    billing_model: pricing.billing_model ?? pricing.billingModel ?? null,
    tier: pricing.tier ?? null,
    currency: pricing.currency ?? 'USD',
    per_query: finiteNumber(pricing.per_query ?? pricing.perQuery, null),
    per_1k_queries: finiteNumber(pricing.per_1k_queries ?? pricing.per1kQueries, null),
    source: pricing.source ?? null,
    source_accessed_at: pricing.source_accessed_at ?? pricing.sourceAccessedAt ?? null,
    notes: pricing.notes ?? null
  };
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
    'Return only the JSON envelope specified by the response schema; do not add prose outside the schema.'
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
    '    <rule>Populate every field in the schema. Use "" for unknown strings and [] for unknown lists.</rule>',
    '    <rule>Do not include markdown fences or prose outside the JSON envelope.</rule>',
    '  </output_rules>',
    '</search_task>'
  ].join('\n');
}

// Strict JSON-schema envelope for text.format. Strict mode requires every
// property to be listed in `required` and `additionalProperties: false`,
// so we ask the model to emit "" / [] for unknown values rather than
// omitting the field.
function buildResponseSchema() {
  return {
    type: 'json_schema',
    name: 'legal_search_results',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rank: { type: 'integer', minimum: 1 },
              title: { type: 'string' },
              bluebook_citation: { type: 'string' },
              citations: { type: 'array', items: { type: 'string' } },
              url: { type: 'string' },
              publisher: { type: 'string' },
              date: { type: 'string' },
              summary: { type: 'string' },
              relevance: { type: 'string' }
            },
            required: [
              'rank',
              'title',
              'bluebook_citation',
              'citations',
              'url',
              'publisher',
              'date',
              'summary',
              'relevance'
            ]
          }
        }
      },
      required: ['results']
    }
  };
}

function streamingEnabled(config = {}) {
  const value = config.stream ?? config.streaming;
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

function buildRequestBody(benchmarkCase, config = {}) {
  assertCaseRow(benchmarkCase);
  const query = benchmarkCase?.prompt ?? '';
  if (!query.trim()) throw new Error('openai-legal-search requires a non-empty case prompt');
  const topK = configuredTopK(config);
  const body = {
    model: configuredModel(config),
    input: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(benchmarkCase, { topK }) }
    ],
    tools: [buildToolConfig(config)],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    text: { format: buildResponseSchema() },
    max_output_tokens: configuredMaxOutputTokens(config)
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
    out[name] = /authorization|api-key/i.test(name) ? '[REDACTED]' : value;
  }
  return out;
}

// The MCP tool config's `headers` field carries the vendor API key
// (Parallel/Exa/TrustFoundry). Snapshot for the run manifest must redact it
// with the same secrets-hygiene rule as the top-level HTTP headers.
function redactRequestBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) return body;
  const tools = body.tools.map((t) => {
    if (t && typeof t === 'object' && t.type === 'mcp' && t.headers && typeof t.headers === 'object') {
      return { ...t, headers: redactHeaders(t.headers) };
    }
    return t;
  });
  return { ...body, tools };
}

// Walk OpenAI Responses `output[]` items and concatenate every
// `output_text` content-part's `text` in order. Streaming mode already
// accumulates this; this helper covers the non-streaming path and the
// completed-payload snapshot inside SSE.
function responseOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text) {
    return payload.output_text;
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    if (item?.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('\n').trim();
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

// Terminal tool errors. Individual `mcp_call` failures are deliberately NOT
// terminal — OpenAI hands MCP tool errors back to the model in-band, and the
// model can recover with a retried call. Rows where the model still produced
// a valid results envelope after some failed mcp_calls should count as
// `completed`; the failedMcpCallCount is tracked separately on
// providerMetadata for observability. Only protocol-level MCP failures
// (list_tools error, unexpected approval request) are terminal.
function findToolError(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const type = item?.type;
    if (type === 'web_search_call') {
      const status = item.status ?? null;
      if (status && status !== 'completed' && status !== 'in_progress' && status !== 'searching') {
        return {
          code: status,
          message: item.error?.message ?? item.message ?? `web_search_call status=${status}`
        };
      }
      if (item.error) {
        return {
          code: item.error.code ?? item.error.type ?? null,
          message: item.error.message ?? 'OpenAI web_search tool error'
        };
      }
    } else if (type === 'mcp_list_tools') {
      if (item.error) {
        return {
          code: item.error.code ?? item.error.type ?? null,
          message: item.error.message ?? 'MCP list_tools error'
        };
      }
      if (item.status && item.status !== 'completed' && item.status !== 'in_progress') {
        return {
          code: item.status,
          message: `mcp_list_tools status=${item.status}`
        };
      }
    } else if (type === 'mcp_approval_request') {
      return {
        code: 'approval_required',
        message: 'MCP server requested approval; benchmark runs with require_approval="never" — check server config'
      };
    }
  }
  return null;
}

// Count failed mcp_call items — recorded on providerMetadata.mcp so we can
// audit how often the model's tool arguments trip the vendor's validation.
// A row with failedMcpCallCount > 0 but status='completed' means the model
// recovered in-band, which is the expected behavior for MCP tool errors.
function countFailedMcpCalls(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  let count = 0;
  for (const item of output) {
    if (item?.type === 'mcp_call' && item.status === 'failed') count += 1;
  }
  return count;
}

// Extract per-mcp_call client-side timings from timestamped SSE events.
// Returns:
//   calls[]  — { name, status, startTsMs, endTsMs, durationMs }
//   gapsMs[] — model-reasoning gaps between one call's completion and the
//              next call's in_progress. Combined with durationMs this
//              decomposes total wall time into (MCP roundtrip) vs (OpenAI
//              reasoning). Correlates 1:1 with vendor backend logs.
function extractMcpCallTimings(events) {
  if (!Array.isArray(events) || !events.length) return { calls: [], gapsMs: [] };
  const startsByIndex = new Map();
  const calls = [];
  for (const e of events) {
    const type = e.data?.type ?? e.event;
    const idx = e.data?.output_index ?? e.data?.item?.output_index;
    if (type === 'response.mcp_call.in_progress') {
      startsByIndex.set(idx, { tsMs: e.tsMs, name: e.data?.item?.name ?? null });
    } else if (type === 'response.mcp_call.completed' || type === 'response.mcp_call.failed') {
      const start = startsByIndex.get(idx);
      if (start) {
        calls.push({
          outputIndex: idx,
          name: start.name ?? e.data?.item?.name ?? null,
          status: type === 'response.mcp_call.completed' ? 'completed' : 'failed',
          startTsMs: start.tsMs,
          endTsMs: e.tsMs,
          durationMs: e.tsMs - start.tsMs
        });
        startsByIndex.delete(idx);
      }
    }
  }
  // Any calls still in flight when the stream ended (e.g. mid-timeout).
  for (const [idx, start] of startsByIndex.entries()) {
    const lastTs = events[events.length - 1]?.tsMs ?? start.tsMs;
    calls.push({
      outputIndex: idx,
      name: start.name,
      status: 'in_flight_at_stream_end',
      startTsMs: start.tsMs,
      endTsMs: null,
      durationMs: lastTs - start.tsMs
    });
  }
  calls.sort((a, b) => a.startTsMs - b.startTsMs);
  const gapsMs = [];
  for (let i = 1; i < calls.length; i += 1) {
    const prevEnd = calls[i - 1].endTsMs;
    if (prevEnd !== null) gapsMs.push(calls[i].startTsMs - prevEnd);
  }
  return { calls, gapsMs };
}

function summarizeDurations(values) {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const sum = arr.reduce((s, v) => s + v, 0);
  const percentile = (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  return {
    n: arr.length,
    minMs: arr[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: arr[arr.length - 1],
    meanMs: Math.round(sum / arr.length),
    totalMs: sum
  };
}

// Walk output[] for mcp_list_tools items and flatten their `tools` field
// into `[{name, description}, ...]`. Recorded on providerMetadata.mcp so
// runs can be audited for which vendor tool surface OpenAI saw.
function extractListedTools(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const tools = [];
  for (const item of output) {
    if (item?.type !== 'mcp_list_tools') continue;
    const list = Array.isArray(item.tools) ? item.tools : [];
    for (const t of list) {
      if (t && typeof t.name === 'string') {
        tools.push({ name: t.name, description: typeof t.description === 'string' ? t.description : null });
      }
    }
  }
  return tools;
}

function normalizeOpenAiResult(result, index) {
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
    .map(normalizeOpenAiResult)
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
  const reasoningTokens =
    usage.output_tokens_details?.reasoning_tokens ??
    usage.outputTokensDetails?.reasoningTokens ??
    0;
  const cachedInputTokens =
    usage.input_tokens_details?.cached_tokens ??
    usage.inputTokensDetails?.cachedTokens ??
    0;
  const totalTokens = usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    totalTokens,
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
  tokenUsage = null,
  mcp = null,
  sseEventCount = null
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
      sseEventCount,
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
      resultCount: 0,
      sseEventCount,
      mcp
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

// Consume the OpenAI Responses SSE stream and accumulate events into a
// payload that mirrors the shape of a non-streaming Responses payload:
// { id, model, status, output: [...], output_text, usage, error }.
// Streaming keeps the connection active for long web_search runs where
// non-streaming would risk edge timeouts.
async function readSseResponse(response) {
  const events = [];
  const payload = {
    id: null,
    object: null,
    status: null,
    model: null,
    output: [],
    output_text: '',
    usage: null,
    error: null,
    incomplete_details: null
  };
  // Track partial items keyed by output_index so we can attach content
  // parts, text deltas, and web_search_call state as they arrive.
  const itemsByIndex = new Map();

  const ensureItem = (index, seed) => {
    if (itemsByIndex.has(index)) return itemsByIndex.get(index);
    const item = seed ? { ...seed } : {};
    if (item.type === 'message' && !Array.isArray(item.content)) item.content = [];
    itemsByIndex.set(index, item);
    return item;
  };

  const applyEvent = (eventType, data) => {
    events.push({ event: eventType, data, tsMs: Date.now() });
    const type = data?.type ?? eventType;
    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const r = data.response ?? {};
        if (r.id) payload.id = r.id;
        if (r.object) payload.object = r.object;
        if (r.status) payload.status = r.status;
        if (r.model) payload.model = r.model;
        break;
      }
      case 'response.output_item.added': {
        ensureItem(data.output_index, data.item ?? {});
        break;
      }
      case 'response.output_item.done': {
        const existing = ensureItem(data.output_index, data.item ?? {});
        // Prefer the fully-formed item from the event, but keep any
        // accumulated text content we already stitched together.
        const finalItem = { ...existing, ...(data.item ?? {}) };
        if (existing.type === 'message' && Array.isArray(existing.content) && existing.content.length) {
          finalItem.content = existing.content;
        }
        itemsByIndex.set(data.output_index, finalItem);
        break;
      }
      case 'response.content_part.added': {
        const item = ensureItem(data.output_index, { type: 'message', content: [] });
        if (!Array.isArray(item.content)) item.content = [];
        item.content[data.content_index] = { ...(data.part ?? {}) };
        break;
      }
      case 'response.content_part.done': {
        const item = ensureItem(data.output_index, { type: 'message', content: [] });
        if (!Array.isArray(item.content)) item.content = [];
        const existing = item.content[data.content_index] ?? {};
        item.content[data.content_index] = { ...existing, ...(data.part ?? {}) };
        break;
      }
      case 'response.output_text.delta': {
        const item = ensureItem(data.output_index, { type: 'message', content: [] });
        if (!Array.isArray(item.content)) item.content = [];
        const idx = data.content_index ?? 0;
        const existing = item.content[idx] ?? { type: 'output_text', text: '' };
        existing.type = existing.type ?? 'output_text';
        existing.text = (existing.text ?? '') + (data.delta ?? '');
        item.content[idx] = existing;
        payload.output_text += data.delta ?? '';
        break;
      }
      case 'response.output_text.done': {
        const item = ensureItem(data.output_index, { type: 'message', content: [] });
        if (!Array.isArray(item.content)) item.content = [];
        const idx = data.content_index ?? 0;
        const existing = item.content[idx] ?? { type: 'output_text', text: '' };
        if (typeof data.text === 'string') existing.text = data.text;
        existing.type = existing.type ?? 'output_text';
        item.content[idx] = existing;
        break;
      }
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
      case 'response.web_search_call.completed':
      case 'response.web_search_call.failed': {
        const item = ensureItem(data.output_index, { type: 'web_search_call', id: data.item_id ?? null });
        item.type = 'web_search_call';
        const status =
          type === 'response.web_search_call.in_progress'
            ? 'in_progress'
            : type === 'response.web_search_call.searching'
              ? 'searching'
              : type === 'response.web_search_call.completed'
                ? 'completed'
                : 'failed';
        item.status = status;
        if (type === 'response.web_search_call.failed' && data.error) {
          item.error = data.error;
        }
        break;
      }
      case 'response.mcp_list_tools.in_progress':
      case 'response.mcp_list_tools.completed':
      case 'response.mcp_list_tools.failed': {
        const item = ensureItem(data.output_index, { type: 'mcp_list_tools', id: data.item_id ?? null });
        item.type = 'mcp_list_tools';
        item.status =
          type === 'response.mcp_list_tools.in_progress'
            ? 'in_progress'
            : type === 'response.mcp_list_tools.completed'
              ? 'completed'
              : 'failed';
        if (data.server_label && !item.server_label) item.server_label = data.server_label;
        if (Array.isArray(data.tools)) item.tools = data.tools;
        if (data.item && typeof data.item === 'object') {
          Object.assign(item, data.item);
        }
        if (type === 'response.mcp_list_tools.failed' && data.error) {
          item.error = data.error;
        }
        break;
      }
      case 'response.mcp_call.in_progress':
      case 'response.mcp_call.arguments.delta':
      case 'response.mcp_call.arguments.done':
      case 'response.mcp_call.completed':
      case 'response.mcp_call.failed': {
        const item = ensureItem(data.output_index, { type: 'mcp_call', id: data.item_id ?? null });
        item.type = 'mcp_call';
        if (data.server_label && !item.server_label) item.server_label = data.server_label;
        if (data.name && !item.name) item.name = data.name;
        if (type === 'response.mcp_call.in_progress') {
          item.status = 'in_progress';
        } else if (type === 'response.mcp_call.arguments.delta') {
          item.arguments = (item.arguments ?? '') + (data.delta ?? '');
        } else if (type === 'response.mcp_call.arguments.done') {
          if (typeof data.arguments === 'string') item.arguments = data.arguments;
        } else if (type === 'response.mcp_call.completed') {
          item.status = 'completed';
        } else {
          item.status = 'failed';
          if (data.error) item.error = data.error;
        }
        break;
      }
      case 'response.mcp_approval_request': {
        const item = ensureItem(data.output_index, { type: 'mcp_approval_request', id: data.item_id ?? null });
        item.type = 'mcp_approval_request';
        if (data.item && typeof data.item === 'object') Object.assign(item, data.item);
        break;
      }
      case 'response.completed': {
        const r = data.response ?? {};
        if (r.id) payload.id = r.id;
        if (r.status) payload.status = r.status;
        if (r.model) payload.model = r.model;
        if (r.usage) payload.usage = r.usage;
        if (r.output_text && !payload.output_text) payload.output_text = r.output_text;
        if (Array.isArray(r.output)) {
          // Prefer the final `output` array from the response snapshot —
          // it's the authoritative list of items, in order.
          payload.output = r.output;
          itemsByIndex.clear();
          r.output.forEach((item, index) => itemsByIndex.set(index, item));
        }
        if (r.incomplete_details) payload.incomplete_details = r.incomplete_details;
        break;
      }
      case 'response.failed': {
        const r = data.response ?? {};
        payload.status = r.status ?? 'failed';
        payload.error = r.error ?? data.error ?? { message: 'Response failed' };
        if (r.usage) payload.usage = r.usage;
        break;
      }
      case 'response.incomplete': {
        const r = data.response ?? {};
        payload.status = r.status ?? 'incomplete';
        payload.incomplete_details = r.incomplete_details ?? data.incomplete_details ?? null;
        if (r.usage) payload.usage = r.usage;
        break;
      }
      case 'error':
      case 'response.error': {
        payload.error = data.error ?? { message: data.message ?? 'Unknown SSE error', code: data.code };
        break;
      }
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
    if (dataText === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(dataText);
    } catch {
      return;
    }
    applyEvent(eventType, data);
  };

  // Track any stream-read error internally so callers get the accumulated
  // events + payload even on mid-stream abort. Without this, an
  // AbortSignal.timeout mid-SSE loses all the mcp_call items we collected
  // up to that point — exactly the data needed to correlate against the
  // vendor's backend logs.
  let streamError = null;
  try {
    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await response.text();
      for (const raw of text.split('\n\n')) {
        const trimmed = raw.trim();
        if (trimmed) parseEventBlock(trimmed);
      }
    } else {
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
    }
  } catch (caught) {
    streamError = caught;
  }

  // If the completed event didn't ship a full output array (short
  // stream), promote whatever we accumulated by index.
  if (!payload.output.length && itemsByIndex.size) {
    payload.output = Array.from(itemsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);
  }
  if (!payload.output_text) {
    payload.output_text = responseOutputText(payload);
  }
  return { events, payload, streamError };
}

async function executeAttempt({
  benchmarkCase,
  endpoint,
  request,
  headers,
  requestTimeoutMs,
  topK,
  fetchFn,
  config = {}
}) {
  const startedAtMs = Date.now();
  let httpStatus = null;
  let responseText = null;
  let responseJson = null;
  let sseEventCount = null;
  let sseEvents = null;
  let sseError = null;
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
    const contentType = response.headers?.get?.('content-type') ?? '';
    const isSse = contentType.includes('text/event-stream');
    if (isSse && response.ok) {
      try {
        const { events, payload, streamError } = await readSseResponse(response);
        sseEventCount = events.length;
        responseJson = payload;
        sseEvents = events;
        if (payload.error) sseError = payload.error;
        if (streamError) {
          if (isAbortError(streamError)) {
            timeoutError = streamError instanceof Error ? streamError.message : String(streamError);
          } else {
            responseParseError = streamError instanceof Error ? streamError.message : String(streamError);
          }
        }
      } catch (caught) {
        if (isAbortError(caught)) {
          timeoutError = caught instanceof Error ? caught.message : String(caught);
        } else {
          responseParseError = caught instanceof Error ? caught.message : String(caught);
        }
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
    body: redactRequestBody(request)
  };
  const usage = tokenUsageFrom(responseJson);
  // Shared MCP metadata for both success and failure paths so partial-state
  // per-call timings survive when a row times out mid-stream. Without this,
  // timeout rows lose all the mcp_call latency data collected before abort —
  // which is exactly what we need to correlate with the vendor's backend logs.
  const mcpMeta = mcpProviderMetadata(config, responseJson, sseEvents);

  if (timeoutError) {
    return makeFailure(
      benchmarkCase,
      'timeout',
      `OpenAI Responses request exceeded ${requestTimeoutMs}ms: ${timeoutError}`,
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage,
        mcp: mcpMeta,
        sseEventCount
      }
    );
  }

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
      `Failed to parse OpenAI response JSON: ${responseParseError}`,
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
    const message = sseError.message ?? sseError.error ?? 'OpenAI SSE error event';
    return makeFailure(
      benchmarkCase,
      'stream_error',
      sseError.type || sseError.code ? `${sseError.type ?? sseError.code}: ${message}` : message,
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage,
        mcp: mcpMeta,
        sseEventCount
      }
    );
  }

  const toolError = findToolError(responseJson);
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
        tokenUsage: usage,
        mcp: mcpMeta,
        sseEventCount
      }
    );
  }

  if (responseJson?.status === 'incomplete') {
    const reason = responseJson.incomplete_details?.reason ?? 'unknown';
    return makeFailure(
      benchmarkCase,
      'incomplete_response',
      `OpenAI Responses incomplete: ${reason}`,
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage,
        mcp: mcpMeta,
        sseEventCount
      }
    );
  }

  const text = (responseOutputText(responseJson) || '').trim();
  const modelOutput = extractJsonFromText(text);
  if (!modelOutput) {
    return makeFailure(
      benchmarkCase,
      'parse_error',
      'OpenAI response text did not contain parseable JSON results',
      {
        endpoint,
        request: redactedRequest,
        httpStatus,
        startedAtMs,
        completedAtMs,
        rawResponse: responseJson,
        tokenUsage: usage,
        mcp: mcpMeta,
        sseEventCount
      }
    );
  }

  const envelope = normalizeEnvelope(benchmarkCase.prompt ?? '', modelOutput, { topK });
  const missingMessage =
    envelope.results.length === 0
      ? 'OpenAI JSON output did not include any results'
      : !hasUsableCitation(envelope)
        ? 'OpenAI JSON output did not include any usable citations'
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
        tokenUsage: usage,
        mcp: mcpMeta,
        sseEventCount
      }),
      rawOutput: {
        endpoint,
        request: redactedRequest,
        httpStatus,
        response: responseJson,
        text,
        normalizedResults: envelope.results,
        sseEventCount,
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
        error: 'missing_results',
        mcp: mcpMeta,
        sseEventCount
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
      webSearchBudget: 'unbounded',
      searchBackend: searchBackendLabel(config),
      mcp: mcpProviderMetadata(config, responseJson, sseEvents),
      backendNotes: config.backend_notes ?? config.backendNotes ?? null,
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
  // Retry only genuinely client-side transient failures. Everything else is
  // a signal about OpenAI's reliability and must be preserved as-is:
  //   - `fetch_error`     : local network / DNS / connection-refused. RETRY.
  //   - `timeout`         : our AbortSignal.timeout fired -> vendor latency
  //                         signal, not transient. NOT RETRIED.
  //   - `stream_error`    : OpenAI emitted response.failed / response.error
  //                         SSE event. NOT RETRIED.
  //   - `http_error` 5xx  : OpenAI server error. NOT RETRIED (honest signal).
  //   - `parse_error`     : OpenAI returned unparseable / truncated JSON.
  //                         NOT RETRIED.
  //   - `tool_error`      : OpenAI's web_search tool failed. NOT RETRIED.
  //   - `incomplete_response`, `missing_results`, `config_error`,
  //     `validation_error` : all NOT RETRIED.
  return kind === 'fetch_error';
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

export const openaiLegalSearchProviderAdapter = {
  id: PROVIDER_ID,
  version: PROVIDER_VERSION,

  async describe({ config = {} }) {
    const searchTool = buildToolConfig(config);
    return {
      id: this.id,
      version: this.version,
      subject: 'case-law-web-search',
      target: config.endpoint ?? DEFAULT_ENDPOINT,
      apiKeyEnv: config.api_key_env ?? config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      settings: {
        model: config.model ?? config.model_id ?? config.modelId ?? null,
        requestTimeoutMs: config.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
        topK: configuredTopK(config),
        maxOutputTokens: configuredMaxOutputTokens(config),
        temperature: config.temperature === undefined ? null : finiteNumber(config.temperature),
        pricing: pricingSnapshot(config),
        searchBackend: searchBackendLabel(config),
        searchTool,
        webSearchTool: searchTool,
        webSearchBudget: 'unbounded',
        backendNotes: config.backend_notes ?? config.backendNotes ?? null,
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
        message.includes('provider config model') || message.includes("search_tool")
          ? 'config_error'
          : 'validation_error';
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

    if (config.search_tool?.kind === 'mcp') {
      const auth = await resolveMcpAuth(config);
      if (!auth.ok) {
        const message = auth.refreshError
          ? `OAuth refresh failed for MCP server auth: ${auth.refreshError}`
          : `Missing env ${auth.envName} for MCP server auth (search_tool.auth.api_key_env)`;
        return makeFailure(benchmarkCase, 'config_error', message, { endpoint, request });
      }
      if (Object.keys(auth.headers).length && Array.isArray(request.tools) && request.tools[0]) {
        request.tools[0] = { ...request.tools[0], headers: auth.headers };
      }
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
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
        fetchFn,
        config
      });
      attempts.push(attemptSummary(result, attempt));
      if (!isRetryableProviderFailure(result)) break;
    }
    return withRetryMetadata(result, attempts);
  }
};

export const _internals = {
  buildMcpToolTemplate,
  buildNativeWebSearchTool,
  buildRequestBody,
  buildResponseSchema,
  buildSystemPrompt,
  buildToolConfig,
  buildUserPrompt,
  buildWebSearchTool: buildToolConfig,
  configuredModel,
  configuredMaxOutputTokens,
  configuredTopK,
  countFailedMcpCalls,
  countMcpCalls,
  extractJsonFromText,
  extractListedTools,
  extractMcpCallTimings,
  findToolError,
  findWebSearchToolError: findToolError,
  hasUsableCitation,
  isAbortError,
  isRetryableProviderFailure,
  jurisdictionDescription,
  mcpPricingSnapshot,
  mcpProviderMetadata,
  normalizeOpenAiResult,
  normalizeEnvelope,
  performOAuthRefresh,
  pricingSnapshot,
  readSseResponse,
  redactRequestBody,
  resolveMcpAuth,
  _resetMcpAuthState,
  responseOutputText,
  searchBackendLabel,
  streamingEnabled,
  summarizeDurations
};
