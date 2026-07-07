import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openaiLegalSearchProviderAdapter,
  _internals
} from '../src/adapters/providers/openai-legal-search.mjs';
import { trustfoundryLegalSearchScorerAdapter } from '@trustfoundry-ai/benchmarks-harness/adapters/scorers/trustfoundry-legal-search';

const CASE_ROW = {
  caseId: 'trustfoundry-legal-search:case_questions:test:76eaa103b27c',
  benchmarkId: 'trustfoundry-legal-search',
  prompt: 'Analyze exclusive county control doctrine.',
  split: 'test',
  metadata: {
    datasetName: 'case_questions',
    doc_type: 'case',
    field: 'questions',
    model_type: 'case_question',
    state: 'MI',
    authority_identifier: 'mich',
    expected: {
      canonical_citation: '13 Mich. 233',
      alternates: ['1865 Mich. LEXIS 19'],
      cl_cluster_id: '6751062'
    }
  }
};

function openaiResponse(text, extra = {}) {
  return new Response(JSON.stringify({
    id: 'resp_123',
    object: 'response',
    status: 'completed',
    model: 'gpt-5.5-test',
    output: [
      {
        type: 'web_search_call',
        id: 'ws_123',
        status: 'completed'
      },
      {
        type: 'message',
        id: 'msg_123',
        role: 'assistant',
        content: [{ type: 'output_text', text }]
      }
    ],
    output_text: text,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 4 },
      total_tokens: 30
    },
    ...extra
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test('buildRequestBody uses configured model, jurisdiction, topK, and web_search tool', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    model: 'gpt-5.5-test',
    top_k: 10
  });

  assert.equal(body.model, 'gpt-5.5-test');
  assert.equal(body.max_output_tokens, 2048);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.name, 'legal_search_results');
  assert.equal(body.input[0].role, 'system');
  assert.equal(body.input[1].role, 'user');
  assert.match(body.input[0].content, /hard jurisdiction filter/);
  assert.match(body.input[1].content, /<target_state>MI<\/target_state>/);
  assert.match(body.input[1].content, /<result_count>10<\/result_count>/);
  assert.match(body.input[1].content, /Apply target_state as the jurisdiction constraint/);
  assert.match(body.input[1].content, /authority=mich/);
  assert.doesNotMatch(JSON.stringify(body), /OPENAI_API_KEY|secret/i);
});

test('buildRequestBody honors allowed/blocked domain filters when provided', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    model: 'gpt-5.5-test',
    allowed_domains: ['courtlistener.com', 'justia.com']
  });
  assert.deepEqual(body.tools[0].filters, { allowed_domains: ['courtlistener.com', 'justia.com'] });
});

test('buildResponseSchema is strict and lists every property in required', () => {
  const schema = _internals.buildResponseSchema();
  assert.equal(schema.strict, true);
  const item = schema.schema.properties.results.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required.sort(), Object.keys(item.properties).sort());
});

test('describe surfaces pricing snapshot and records web_search budget as unbounded', async () => {
  const description = await openaiLegalSearchProviderAdapter.describe({
    config: {
      model: 'gpt-5.5-2026-04-23',
      pricing: {
        model: 'gpt-5.5-2026-04-23',
        pricing_level: 'OpenAI API standard pricing',
        source: 'https://developers.openai.com/api/docs/pricing',
        source_accessed_at: '2026-07-06',
        currency: 'USD',
        unit: 'per_1m_tokens',
        input_per_million_tokens: 5,
        output_per_million_tokens: 30
      }
    }
  });

  assert.deepEqual(description.settings.pricing, {
    model: 'gpt-5.5-2026-04-23',
    pricing_level: 'OpenAI API standard pricing',
    source: 'https://developers.openai.com/api/docs/pricing',
    source_accessed_at: '2026-07-06',
    currency: 'USD',
    unit: 'per_1m_tokens',
    input_per_million_tokens: 5,
    output_per_million_tokens: 30
  });
  assert.equal(description.settings.webSearchBudget, 'unbounded');
});

test('executeCase normalizes OpenAI JSON into scorer-compatible citation fields', async () => {
  const calls = [];
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        top_k: 25,
        _fetch: async (url, init) => {
          calls.push({ url, init });
          return openaiResponse(JSON.stringify({
            results: [
              {
                rank: 1,
                title: 'People ex rel. Schmittdiel v. Board of Auditors',
                bluebook_citation: '13 Mich. 233',
                citations: ['13 Mich. 233', '1865 Mich. LEXIS 19'],
                url: 'https://www.courtlistener.com/opinion/6751062/',
                publisher: 'CourtListener',
                date: '1865',
                summary: 'Michigan county control decision.',
                relevance: 'Directly addresses exclusive county control.'
              }
            ]
          }));
        }
      }
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(result.rawOutput.request.headers.Authorization, '[REDACTED]');
  assert.equal(result.providerMetadata.model, 'gpt-5.5-test');
  assert.equal(result.providerMetadata.webSearchBudget, 'unbounded');
  assert.equal(result.tokenUsage.inputTokens, 10);
  assert.equal(result.tokenUsage.outputTokens, 20);
  assert.equal(result.tokenUsage.reasoningTokens, 4);
  assert.equal(result.tokenUsage.totalTokens, 30);

  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 1);
  assert.equal(envelope.results[0].citation, '13 Mich. 233');
  assert.deepEqual(envelope.results[0].citations, ['13 Mich. 233', '1865 Mich. LEXIS 19']);
  assert.equal(envelope.results[0].bluebook_citation, '13 Mich. 233');
  assert.equal(envelope.results[0].result_type, 'case');
});

test('extractJsonFromText accepts fenced JSON as a defensive fallback', () => {
  const parsed = _internals.extractJsonFromText([
    '```json',
    '{"results":[{"rank":1,"title":"Example","bluebook_citation":"1 U.S. 1"}]}',
    '```'
  ].join('\n'));

  assert.equal(parsed.results[0].bluebook_citation, '1 U.S. 1');
});

test('executeCase fails gracefully when OpenAI reports a web_search tool failure', async () => {
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => new Response(JSON.stringify({
          id: 'resp_err',
          status: 'completed',
          model: 'gpt-5.5-test',
          output: [
            {
              type: 'web_search_call',
              id: 'ws_err',
              status: 'failed',
              error: { code: 'rate_limited', message: 'Search is rate limited' }
            }
          ],
          output_text: ''
        }), { status: 200 })
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'tool_error');
  assert.match(result.error.message, /rate_limited|failed/);
});

test('executeCase fails gracefully on malformed OpenAI result JSON', async () => {
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => openaiResponse('I found the case, but no JSON.')
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'parse_error');
  assert.match(result.error.message, /parseable JSON/);
});

test('executeCase surfaces status=incomplete responses as incomplete_response failures', async () => {
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => new Response(JSON.stringify({
          id: 'resp_incomplete',
          status: 'incomplete',
          model: 'gpt-5.5-test',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
          output_text: '',
          usage: { input_tokens: 20, output_tokens: 10000, total_tokens: 10020 }
        }), { status: 200 })
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'incomplete_response');
  assert.match(result.error.message, /max_output_tokens/);
});

test('executeCase rejects non-case Legal Search rows before fetch', async () => {
  let fetchCalled = false;
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: {
        caseId: 'law-row',
        prompt: 'Find this statute.',
        metadata: { doc_type: 'law', model_type: 'law_question' }
      },
      config: {
        model: 'gpt-5.5-test',
        _fetch: async () => {
          fetchCalled = true;
          return openaiResponse('{"results":[]}');
        }
      }
    })
  );

  assert.equal(fetchCalled, false);
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'validation_error');
  assert.match(result.error.message, /only supports case rows/);
});

test('executeCase does NOT retry 5xx OpenAI server errors (honest signal, one attempt)', async () => {
  let calls = 0;
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
        }
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  assert.equal(result.error.status, 503);
  assert.equal(calls, 1);
  assert.equal(result.retryMetadata, null);
});

test('executeCase retries client-side fetch_error once and then succeeds', async () => {
  let calls = 0;
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error('getaddrinfo ENOTFOUND api.openai.com');
            err.name = 'TypeError';
            throw err;
          }
          return openaiResponse(JSON.stringify({
            results: [
              { rank: 1, title: 'Example', bluebook_citation: '13 Mich. 233' }
            ]
          }));
        }
      }
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(result.retryMetadata.retryCount, 1);
  assert.equal(result.retryMetadata.attempts[0].error.kind, 'fetch_error');
});

function sseResponse(eventBlocks) {
  const body = eventBlocks
    .map((block) => `event: ${block.event}\ndata: ${JSON.stringify(block.data)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

test('buildRequestBody defaults stream to true, honors explicit override', () => {
  const streamed = _internals.buildRequestBody(CASE_ROW, { model: 'gpt-5.5-test' });
  assert.equal(streamed.stream, true);

  const disabled = _internals.buildRequestBody(CASE_ROW, {
    model: 'gpt-5.5-test',
    stream: false
  });
  assert.equal(Object.hasOwn(disabled, 'stream'), false);
});

test('readSseResponse accumulates output_text deltas and usage into a final payload', async () => {
  const response = sseResponse([
    {
      event: 'response.created',
      data: {
        type: 'response.created',
        response: { id: 'resp_stream_1', object: 'response', status: 'in_progress', model: 'gpt-5.5-test' }
      }
    },
    {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_stream_1', role: 'assistant', content: [] }
      }
    },
    {
      event: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' }
      }
    },
    {
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: '{"results":'
      }
    },
    {
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: '[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}'
      }
    },
    {
      event: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        output_index: 0,
        content_index: 0,
        text: '{"results":[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}'
      }
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_stream_1',
          status: 'completed',
          model: 'gpt-5.5-test',
          output: [
            {
              type: 'message',
              id: 'msg_stream_1',
              role: 'assistant',
              content: [
                { type: 'output_text', text: '{"results":[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}' }
              ]
            }
          ],
          output_text: '{"results":[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}',
          usage: {
            input_tokens: 42,
            output_tokens: 88,
            output_tokens_details: { reasoning_tokens: 12 },
            total_tokens: 130
          }
        }
      }
    }
  ]);

  const { events, payload } = await _internals.readSseResponse(response);
  assert.equal(events.length, 7);
  assert.equal(payload.id, 'resp_stream_1');
  assert.equal(payload.model, 'gpt-5.5-test');
  assert.equal(payload.status, 'completed');
  assert.equal(payload.usage.input_tokens, 42);
  assert.equal(payload.usage.output_tokens, 88);
  assert.equal(
    payload.output_text,
    '{"results":[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}'
  );
  assert.equal(payload.output.length, 1);
  assert.equal(payload.output[0].type, 'message');
  assert.equal(payload.output[0].content[0].text, '{"results":[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}');
});

test('executeCase parses streaming OpenAI response and reports SSE metadata', async () => {
  const providerResult = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_1', object: 'response', status: 'in_progress', model: 'gpt-5.5-test' }
            }
          },
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] }
            }
          },
          {
            event: 'response.content_part.added',
            data: {
              type: 'response.content_part.added',
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '' }
            }
          },
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: '{"results":[{"rank":1,"title":"Schmittdiel","bluebook_citation":"13 Mich. 233"}]}'
            }
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                status: 'completed',
                model: 'gpt-5.5-test',
                output: [
                  {
                    type: 'message',
                    id: 'msg_1',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: '{"results":[{"rank":1,"title":"Schmittdiel","bluebook_citation":"13 Mich. 233"}]}' }
                    ]
                  }
                ],
                output_text: '{"results":[{"rank":1,"title":"Schmittdiel","bluebook_citation":"13 Mich. 233"}]}',
                usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }
              }
            }
          }
        ])
      }
    })
  );

  assert.equal(providerResult.status, 'completed');
  assert.equal(providerResult.providerMetadata.streaming, true);
  assert.equal(providerResult.providerMetadata.sseEventCount, 5);
  assert.equal(providerResult.tokenUsage.inputTokens, 100);
  assert.equal(providerResult.tokenUsage.outputTokens, 50);
  const envelope = JSON.parse(providerResult.finalOutputText);
  assert.equal(envelope.results[0].bluebook_citation, '13 Mich. 233');
});

test('isAbortError detects TimeoutError, AbortError, and canonical timeout messages', () => {
  const timeoutErr = new Error('The operation was aborted due to timeout');
  timeoutErr.name = 'TimeoutError';
  assert.equal(_internals.isAbortError(timeoutErr), true);

  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';
  assert.equal(_internals.isAbortError(abortErr), true);

  const messageOnly = new Error('The operation was aborted due to timeout');
  assert.equal(_internals.isAbortError(messageOnly), true);

  const other = new Error('Unexpected token in JSON');
  assert.equal(_internals.isAbortError(other), false);

  assert.equal(_internals.isAbortError(null), false);
});

test('executeCase classifies AbortSignal.timeout during initial fetch as timeout (final, not retried)', async () => {
  let calls = 0;
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        request_timeout_ms: 50,
        _fetch: async () => {
          calls += 1;
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'timeout');
  assert.match(result.error.message, /exceeded/);
  assert.equal(calls, 1);
  assert.equal(result.retryMetadata, null);
});

test('executeCase classifies abort DURING SSE stream as timeout (not parse_error, not retried)', async () => {
  let calls = 0;
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => {
          calls += 1;
          // SSE headers arrive OK, then the body stream throws an
          // AbortError partway through reading — reproduces the failure
          // mode seen in the 20-row run.
          const stream = new ReadableStream({
            start(controller) {
              const err = new Error('The operation was aborted due to timeout');
              err.name = 'TimeoutError';
              controller.error(err);
            }
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          });
        }
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'timeout');
  assert.match(result.error.message, /exceeded/);
  assert.equal(calls, 1);
  assert.equal(result.retryMetadata, null);
});

test('executeCase reports SSE stream_error when OpenAI emits response.failed', async () => {
  const result = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_2', object: 'response', status: 'in_progress', model: 'gpt-5.5-test' }
            }
          },
          {
            event: 'response.failed',
            data: {
              type: 'response.failed',
              response: {
                id: 'resp_2',
                status: 'failed',
                error: { type: 'server_error', message: 'Server temporarily overloaded' }
              }
            }
          }
        ])
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'stream_error');
  assert.match(result.error.message, /overloaded/);
});

test('OpenAI-normalized Bluebook citation output scores with trustfoundry-legal-search scorer', async () => {
  const providerResult = await withEnv('OPENAI_API_KEY', 'secret-key', () =>
    openaiLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'gpt-5.5-test',
        api_key_env: 'OPENAI_API_KEY',
        _fetch: async () => openaiResponse(JSON.stringify({
          results: [
            {
              rank: 1,
              title: 'People ex rel. Schmittdiel v. Board of Auditors',
              bluebook_citation: '13 Mich. 233'
            }
          ]
        }))
      }
    })
  );

  const scores = await trustfoundryLegalSearchScorerAdapter.score({
    manifest: { run_id: 'openai-test' },
    cases: [CASE_ROW],
    providerResults: [providerResult]
  });

  assert.equal(scores.caseScores[0].hitRank, 1);
  assert.equal(scores.summary.hitAt1, 1);
  assert.equal(scores.summary.hitAt25, 1);
});

// -----------------------------------------------------------------------
// MCP search backend
// -----------------------------------------------------------------------

const PARALLEL_MCP_CONFIG = {
  model: 'gpt-5.5-test',
  api_key_env: 'OPENAI_API_KEY',
  search_tool: {
    kind: 'mcp',
    server_label: 'parallel-search',
    server_url: 'https://search.parallel.ai/mcp',
    auth: {
      header: 'Authorization',
      scheme: 'Bearer',
      api_key_env: 'PARALLEL_API_KEY'
    },
    require_approval: 'never'
  },
  backend_notes: { vendor: 'parallel', mode: 'basic' },
  mcp_pricing: { vendor: 'parallel', billing_model: 'free_anonymous_tier', per_query: 0 }
};

test('buildToolConfig defaults to native OpenAI web_search', () => {
  const tool = _internals.buildToolConfig({});
  assert.deepEqual(tool, { type: 'web_search' });
});

test('buildToolConfig honors native domain filters', () => {
  const tool = _internals.buildToolConfig({
    allowed_domains: ['courtlistener.com'],
    blocked_domains: ['reddit.com']
  });
  assert.equal(tool.type, 'web_search');
  assert.deepEqual(tool.filters, {
    allowed_domains: ['courtlistener.com'],
    blocked_domains: ['reddit.com']
  });
});

test('buildToolConfig builds MCP template without headers (env resolved later)', () => {
  const tool = _internals.buildToolConfig({
    search_tool: {
      kind: 'mcp',
      server_label: 'parallel-search',
      server_url: 'https://search.parallel.ai/mcp',
      auth: { api_key_env: 'PARALLEL_API_KEY' }
    }
  });
  assert.equal(tool.type, 'mcp');
  assert.equal(tool.server_label, 'parallel-search');
  assert.equal(tool.server_url, 'https://search.parallel.ai/mcp');
  assert.equal(tool.require_approval, 'never');
  // Headers are NOT resolved by buildToolConfig — describe() must be safe
  // to call without the vendor env var set.
  assert.equal(Object.hasOwn(tool, 'headers'), false);
});

test('buildToolConfig passes allowed_tools filter through to MCP', () => {
  const tool = _internals.buildToolConfig({
    search_tool: {
      kind: 'mcp',
      server_label: 'exa',
      server_url: 'https://mcp.exa.ai/mcp',
      allowed_tools: ['web_search_exa']
    }
  });
  assert.deepEqual(tool.allowed_tools, ['web_search_exa']);
});

test('buildToolConfig throws on unknown kind (config_error path)', () => {
  assert.throws(
    () => _internals.buildToolConfig({ search_tool: { kind: 'bogus' } }),
    /unknown search_tool.kind/
  );
});

test('buildToolConfig throws when MCP config missing server_label / server_url', () => {
  assert.throws(
    () => _internals.buildToolConfig({ search_tool: { kind: 'mcp', server_url: 'https://x' } }),
    /server_label/
  );
  assert.throws(
    () => _internals.buildToolConfig({ search_tool: { kind: 'mcp', server_label: 'x' } }),
    /server_url/
  );
});

test('resolveMcpAuth returns headers with scheme prefix when env is set', async () => {
  await withEnv('PARALLEL_API_KEY', 'secret-mcp', async () => {
    const auth = await _internals.resolveMcpAuth(PARALLEL_MCP_CONFIG);
    assert.equal(auth.ok, true);
    assert.deepEqual(auth.headers, { Authorization: 'Bearer secret-mcp' });
  });
});

test('resolveMcpAuth signals missing env var, does not throw', async () => {
  // Ensure the env is unset.
  const prev = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  try {
    const auth = await _internals.resolveMcpAuth(PARALLEL_MCP_CONFIG);
    assert.equal(auth.ok, false);
    assert.equal(auth.envName, 'PARALLEL_API_KEY');
  } finally {
    if (prev !== undefined) process.env.PARALLEL_API_KEY = prev;
  }
});

test('resolveMcpAuth returns empty headers for anonymous MCP endpoint (no auth block)', async () => {
  const auth = await _internals.resolveMcpAuth({
    search_tool: { kind: 'mcp', server_label: 'anon', server_url: 'https://x/mcp' }
  });
  assert.equal(auth.ok, true);
  assert.deepEqual(auth.headers, {});
});

test('resolveMcpAuth refreshes access token when within expiry buffer', async () => {
  _internals._resetMcpAuthState();
  const nowSec = Math.floor(Date.now() / 1000);
  const stale = nowSec - 60; // already-expired seed
  await withEnv('TF_TOKEN', 'stale-token', () =>
    withEnv('TF_REFRESH', 'refresh-abc', () =>
      withEnv('TF_CLIENT_ID', 'client-xyz', () =>
        withEnv('TF_EXPIRES_AT', String(stale), async () => {
          const refreshCalls = [];
          const auth = await _internals.resolveMcpAuth({
            search_tool: {
              kind: 'mcp',
              server_label: 'tf',
              server_url: 'https://mcp.trustfoundry.ai/api/mcp',
              auth: {
                header: 'Authorization',
                scheme: 'Bearer',
                api_key_env: 'TF_TOKEN',
                refresh: {
                  token_endpoint: 'https://mcp.trustfoundry.ai/api/oauth/token',
                  refresh_token_env: 'TF_REFRESH',
                  client_id_env: 'TF_CLIENT_ID',
                  expires_at_env: 'TF_EXPIRES_AT',
                  refresh_before_seconds: 300
                }
              }
            },
            _refreshFetch: async (url, init) => {
              refreshCalls.push({ url, body: init.body?.toString?.() ?? String(init.body) });
              return new Response(JSON.stringify({
                access_token: 'fresh-token-9',
                refresh_token: 'refresh-rotated',
                expires_in: 3600,
                token_type: 'Bearer'
              }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
          });
          assert.equal(auth.ok, true);
          assert.deepEqual(auth.headers, { Authorization: 'Bearer fresh-token-9' });
          assert.equal(refreshCalls.length, 1);
          assert.match(refreshCalls[0].body, /grant_type=refresh_token/);
          assert.match(refreshCalls[0].body, /client_id=client-xyz/);
          // Rotated refresh token should now be in-process.
          assert.equal(process.env.TF_REFRESH, 'refresh-rotated');
        })
      )
    )
  );
});

test('resolveMcpAuth coalesces concurrent refreshes into a single request', async () => {
  _internals._resetMcpAuthState();
  const nowSec = Math.floor(Date.now() / 1000);
  const stale = nowSec - 60;
  await withEnv('TF_TOKEN', 'stale', () =>
    withEnv('TF_REFRESH', 'ref', () =>
      withEnv('TF_CLIENT_ID', 'cid', () =>
        withEnv('TF_EXPIRES_AT', String(stale), async () => {
          let calls = 0;
          const cfg = {
            search_tool: {
              kind: 'mcp',
              server_label: 'tf',
              server_url: 'https://mcp.trustfoundry.ai/api/mcp',
              auth: {
                header: 'Authorization',
                scheme: 'Bearer',
                api_key_env: 'TF_TOKEN',
                refresh: {
                  token_endpoint: 'https://mcp.trustfoundry.ai/api/oauth/token',
                  refresh_token_env: 'TF_REFRESH',
                  client_id_env: 'TF_CLIENT_ID',
                  expires_at_env: 'TF_EXPIRES_AT'
                }
              }
            },
            _refreshFetch: async () => {
              calls += 1;
              // Small delay so the four concurrent calls all queue behind the first.
              await new Promise((r) => setTimeout(r, 20));
              return new Response(JSON.stringify({
                access_token: 'shared',
                expires_in: 3600
              }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
          };
          const results = await Promise.all([
            _internals.resolveMcpAuth(cfg),
            _internals.resolveMcpAuth(cfg),
            _internals.resolveMcpAuth(cfg),
            _internals.resolveMcpAuth(cfg)
          ]);
          for (const r of results) {
            assert.equal(r.ok, true);
            assert.equal(r.headers.Authorization, 'Bearer shared');
          }
          assert.equal(calls, 1);
        })
      )
    )
  );
});

test('resolveMcpAuth reports refreshError instead of throwing when token endpoint fails', async () => {
  _internals._resetMcpAuthState();
  const stale = Math.floor(Date.now() / 1000) - 60;
  await withEnv('TF_TOKEN', 'stale', () =>
    withEnv('TF_REFRESH', 'ref', () =>
      withEnv('TF_EXPIRES_AT', String(stale), async () => {
        const auth = await _internals.resolveMcpAuth({
          search_tool: {
            kind: 'mcp',
            server_label: 'tf',
            server_url: 'https://mcp.trustfoundry.ai/api/mcp',
            auth: {
              api_key_env: 'TF_TOKEN',
              refresh: {
                token_endpoint: 'https://mcp.trustfoundry.ai/api/oauth/token',
                refresh_token_env: 'TF_REFRESH',
                expires_at_env: 'TF_EXPIRES_AT'
              }
            }
          },
          _refreshFetch: async () =>
            new Response('{"error":"invalid_grant"}', { status: 400 })
        });
        assert.equal(auth.ok, false);
        assert.match(auth.refreshError, /HTTP 400/);
      })
    )
  );
});

test('searchBackendLabel reflects native vs mcp:<label>', () => {
  assert.equal(_internals.searchBackendLabel({}), 'openai-native-web-search');
  assert.equal(_internals.searchBackendLabel(PARALLEL_MCP_CONFIG), 'mcp:parallel-search');
});

test('findToolError does NOT classify failed mcp_call as terminal', () => {
  // MCP tool errors are handed back to the model in-band; the model can
  // recover with a corrected call. Only protocol-level MCP failures
  // (list_tools, unexpected approval) are terminal.
  const err = _internals.findToolError({
    output: [
      {
        type: 'mcp_call',
        status: 'failed',
        error: { code: 'invalid_arg', message: 'invalid argument' }
      }
    ]
  });
  assert.equal(err, null);
});

test('countFailedMcpCalls tracks per-call failures for observability', () => {
  const count = _internals.countFailedMcpCalls({
    output: [
      { type: 'mcp_call', status: 'completed' },
      { type: 'mcp_call', status: 'failed', error: { message: 'bad args' } },
      { type: 'mcp_call', status: 'failed', error: { message: 'rate limited' } },
      { type: 'web_search_call', status: 'failed' }
    ]
  });
  assert.equal(count, 2);
});

test('findToolError classifies mcp_list_tools with error as tool_error', () => {
  const err = _internals.findToolError({
    output: [
      { type: 'mcp_list_tools', error: { code: 'unauthorized', message: 'Bad API key' } }
    ]
  });
  assert.equal(err.code, 'unauthorized');
  assert.match(err.message, /Bad API key/);
});

test('findToolError surfaces mcp_approval_request as tool_error', () => {
  const err = _internals.findToolError({
    output: [{ type: 'mcp_approval_request', id: 'appr_1' }]
  });
  assert.equal(err.code, 'approval_required');
  assert.match(err.message, /require_approval="never"/);
});

test('extractListedTools flattens mcp_list_tools items', () => {
  const tools = _internals.extractListedTools({
    output: [
      {
        type: 'mcp_list_tools',
        tools: [
          { name: 'web_search', description: 'Parallel search' },
          { name: 'other', description: null }
        ]
      }
    ]
  });
  assert.deepEqual(tools, [
    { name: 'web_search', description: 'Parallel search' },
    { name: 'other', description: null }
  ]);
});

test('countMcpCalls counts only completed mcp_call items', () => {
  const count = _internals.countMcpCalls({
    output: [
      { type: 'mcp_call', status: 'completed' },
      { type: 'mcp_call', status: 'completed' },
      { type: 'mcp_call', status: 'failed' },
      { type: 'web_search_call', status: 'completed' }
    ]
  });
  assert.equal(count, 2);
});

test('redactRequestBody strips MCP headers from the manifest snapshot', () => {
  const redacted = _internals.redactRequestBody({
    model: 'gpt-5.5-test',
    tools: [
      { type: 'mcp', server_label: 'x', headers: { Authorization: 'Bearer secret-mcp' } }
    ]
  });
  assert.deepEqual(redacted.tools[0].headers, { Authorization: '[REDACTED]' });
});

test('executeCase with MCP config emits mcp providerMetadata and redacts secret', async () => {
  const calls = [];
  const result = await withEnv('OPENAI_API_KEY', 'openai-secret', () =>
    withEnv('PARALLEL_API_KEY', 'parallel-secret', () =>
      openaiLegalSearchProviderAdapter.executeCase({
        benchmarkCase: CASE_ROW,
        config: {
          ...PARALLEL_MCP_CONFIG,
          _fetch: async (url, init) => {
            calls.push({ url, init });
            return new Response(JSON.stringify({
              id: 'resp_mcp_1',
              status: 'completed',
              model: 'gpt-5.5-test',
              output: [
                {
                  type: 'mcp_list_tools',
                  status: 'completed',
                  server_label: 'parallel-search',
                  tools: [{ name: 'web_search', description: 'Parallel web search' }]
                },
                { type: 'mcp_call', status: 'completed', server_label: 'parallel-search', name: 'web_search' },
                { type: 'mcp_call', status: 'completed', server_label: 'parallel-search', name: 'web_search' },
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: JSON.stringify({
                        results: [
                          {
                            rank: 1,
                            title: 'Schmittdiel',
                            bluebook_citation: '13 Mich. 233',
                            citations: ['13 Mich. 233'],
                            url: 'https://www.courtlistener.com/opinion/6751062/'
                          }
                        ]
                      })
                    }
                  ]
                }
              ],
              output_text: '',
              usage: { input_tokens: 40, output_tokens: 60, total_tokens: 100 }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
        }
      })
    )
  );

  assert.equal(result.status, 'completed');
  const sentBody = JSON.parse(calls[0].init.body);
  assert.equal(sentBody.tools[0].type, 'mcp');
  assert.equal(sentBody.tools[0].server_label, 'parallel-search');
  assert.equal(sentBody.tools[0].headers.Authorization, 'Bearer parallel-secret');

  // The snapshot the harness records must have the MCP secret scrubbed.
  const snapshotBody = result.rawOutput.request.body;
  assert.equal(snapshotBody.tools[0].headers.Authorization, '[REDACTED]');

  assert.equal(result.providerMetadata.searchBackend, 'mcp:parallel-search');
  assert.equal(result.providerMetadata.mcp.serverLabel, 'parallel-search');
  assert.equal(result.providerMetadata.mcp.callCount, 2);
  assert.deepEqual(result.providerMetadata.mcp.listedTools, [
    { name: 'web_search', description: 'Parallel web search' }
  ]);
  assert.equal(result.providerMetadata.mcp.pricing.vendor, 'parallel');
  assert.equal(result.providerMetadata.mcp.pricing.per_query, 0);
  assert.deepEqual(result.providerMetadata.backendNotes, { vendor: 'parallel', mode: 'basic' });
});

test('executeCase with MCP config reports config_error when vendor env is missing', async () => {
  const prev = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  try {
    const result = await withEnv('OPENAI_API_KEY', 'openai-secret', () =>
      openaiLegalSearchProviderAdapter.executeCase({
        benchmarkCase: CASE_ROW,
        config: {
          ...PARALLEL_MCP_CONFIG,
          _fetch: async () => {
            throw new Error('should not be called');
          }
        }
      })
    );
    assert.equal(result.status, 'provider_failure');
    assert.equal(result.error.kind, 'config_error');
    assert.match(result.error.message, /PARALLEL_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.PARALLEL_API_KEY = prev;
  }
});

test('readSseResponse accumulates mcp_list_tools and mcp_call items', async () => {
  const response = sseResponse([
    {
      event: 'response.created',
      data: {
        type: 'response.created',
        response: { id: 'resp_mcp', object: 'response', status: 'in_progress', model: 'gpt-5.5-test' }
      }
    },
    {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'mcp_list_tools', id: 'mlt_1', server_label: 'parallel-search' }
      }
    },
    {
      event: 'response.mcp_list_tools.completed',
      data: {
        type: 'response.mcp_list_tools.completed',
        output_index: 0,
        item_id: 'mlt_1',
        server_label: 'parallel-search',
        tools: [{ name: 'web_search', description: 'Parallel search' }]
      }
    },
    {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'mcp_call', id: 'mc_1', server_label: 'parallel-search', name: 'web_search' }
      }
    },
    {
      event: 'response.mcp_call.completed',
      data: {
        type: 'response.mcp_call.completed',
        output_index: 1,
        item_id: 'mc_1'
      }
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_mcp',
          status: 'completed',
          model: 'gpt-5.5-test',
          output: [
            {
              type: 'mcp_list_tools',
              id: 'mlt_1',
              status: 'completed',
              server_label: 'parallel-search',
              tools: [{ name: 'web_search', description: 'Parallel search' }]
            },
            { type: 'mcp_call', id: 'mc_1', status: 'completed', server_label: 'parallel-search', name: 'web_search' }
          ],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
        }
      }
    }
  ]);

  const { payload } = await _internals.readSseResponse(response);
  assert.equal(payload.status, 'completed');
  assert.equal(payload.output.length, 2);
  assert.equal(payload.output[0].type, 'mcp_list_tools');
  assert.equal(payload.output[1].type, 'mcp_call');
  assert.equal(payload.output[1].status, 'completed');
});
