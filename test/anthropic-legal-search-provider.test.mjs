import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anthropicLegalSearchProviderAdapter,
  _internals
} from '../src/adapters/providers/anthropic-legal-search.mjs';
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

function anthropicResponse(text, extra = {}) {
  return new Response(JSON.stringify({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3
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

test('buildRequestBody uses configured model, jurisdiction, topK, and web search tool', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    model: 'claude-test-model',
    top_k: 10,
    web_search_max_uses: 2
  });

  assert.equal(body.model, 'claude-test-model');
  assert.equal(body.max_tokens, 2048);
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.deepEqual(body.tools, [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 2 }
  ]);
  assert.match(body.system, /hard jurisdiction filter/);
  assert.match(body.messages[0].content, /<target_state>MI<\/target_state>/);
  assert.match(body.messages[0].content, /<result_count>10<\/result_count>/);
  assert.match(body.messages[0].content, /Apply target_state as the jurisdiction constraint/);
  assert.match(body.messages[0].content, /authority=mich/);
  assert.doesNotMatch(JSON.stringify(body), /ANTHROPIC_API_KEY|secret/i);
});

test('buildSystemPrompt instructs the LLM to return the exact JSON envelope shape', () => {
  const system = _internals.buildSystemPrompt();
  assert.match(system, /Return only valid JSON/);
  assert.match(system, /"results":\[/);
  assert.match(system, /"bluebook_citation"/);
  assert.match(system, /"citations":\[\]/);
});

test('describe surfaces pricing snapshot from provider config', async () => {
  const description = await anthropicLegalSearchProviderAdapter.describe({
    config: {
      model: 'claude-opus-4-8',
      pricing: {
        model: 'claude-opus-4-8',
        pricing_level: 'Claude API standard pricing',
        source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
        source_accessed_at: '2026-07-05',
        currency: 'USD',
        unit: 'per_1m_tokens',
        input_per_million_tokens: 5,
        output_per_million_tokens: 25
      }
    }
  });

  assert.deepEqual(description.settings.pricing, {
    model: 'claude-opus-4-8',
    pricing_level: 'Claude API standard pricing',
    source: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    source_accessed_at: '2026-07-05',
    currency: 'USD',
    unit: 'per_1m_tokens',
    input_per_million_tokens: 5,
    output_per_million_tokens: 25
  });
});

test('executeCase normalizes Claude JSON into scorer-compatible citation fields', async () => {
  const calls = [];
  const result = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'claude-test-model',
        api_key_env: 'ANTHROPIC_API_KEY',
        top_k: 25,
        _fetch: async (url, init) => {
          calls.push({ url, init });
          return anthropicResponse(JSON.stringify({
            results: [
              {
                rank: 1,
                title: 'People ex rel. Schmittdiel v. Board of Auditors',
                bluebook_citation: '13 Mich. 233',
                citations: ['13 Mich. 233', '1865 Mich. LEXIS 19'],
                url: 'https://www.courtlistener.com/opinion/6751062/',
                publisher: 'CourtListener',
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
  assert.equal(calls[0].init.headers['x-api-key'], 'secret-key');
  assert.equal(result.rawOutput.request.headers['x-api-key'], '[REDACTED]');
  assert.equal(result.providerMetadata.model, 'claude-test-model');
  assert.deepEqual(result.tokenUsage, {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 3,
    totalTokens: 35,
    raw: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3
    }
  });

  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 1);
  assert.equal(envelope.results[0].citation, '13 Mich. 233');
  assert.deepEqual(envelope.results[0].citations, ['13 Mich. 233', '1865 Mich. LEXIS 19']);
  assert.equal(envelope.results[0].bluebook_citation, '13 Mich. 233');
  assert.equal(envelope.results[0].result_type, 'case');
});

test('extractJsonFromText accepts fenced Claude JSON despite prompt instructions', () => {
  const parsed = _internals.extractJsonFromText([
    '```json',
    '{"results":[{"rank":1,"title":"Example","bluebook_citation":"1 U.S. 1"}]}',
    '```'
  ].join('\n'));

  assert.equal(parsed.results[0].bluebook_citation, '1 U.S. 1');
});

test('executeCase fails gracefully when Claude reports a web search tool error', async () => {
  const result = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'claude-test-model',
        api_key_env: 'ANTHROPIC_API_KEY',
        _fetch: async () => new Response(JSON.stringify({
          content: [
            {
              type: 'web_search_tool_result',
              content: {
                type: 'web_search_tool_result_error',
                error_code: 'too_many_requests',
                message: 'Search is rate limited'
              }
            }
          ]
        }), { status: 200 })
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'tool_error');
  assert.match(result.error.message, /too_many_requests/);
});

test('executeCase fails gracefully on malformed Claude result JSON', async () => {
  const result = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'claude-test-model',
        api_key_env: 'ANTHROPIC_API_KEY',
        _fetch: async () => anthropicResponse('I found the case, but no JSON.')
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'parse_error');
  assert.match(result.error.message, /parseable JSON/);
});

test('executeCase rejects non-case Legal Search rows before fetch', async () => {
  let fetchCalled = false;
  const result = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: {
        caseId: 'law-row',
        prompt: 'Find this statute.',
        metadata: { doc_type: 'law', model_type: 'law_question' }
      },
      config: {
        model: 'claude-test-model',
        _fetch: async () => {
          fetchCalled = true;
          return anthropicResponse('{"results":[]}');
        }
      }
    })
  );

  assert.equal(fetchCalled, false);
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'validation_error');
  assert.match(result.error.message, /only supports case rows/);
});

test('executeCase retries once on retryable 5xx provider errors', async () => {
  let calls = 0;
  const result = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'claude-test-model',
        api_key_env: 'ANTHROPIC_API_KEY',
        _fetch: async () => {
          calls += 1;
          if (calls === 1) {
            return new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
              status: 529
            });
          }
          return anthropicResponse(JSON.stringify({
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
  assert.equal(result.providerMetadata.attempts, 2);
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
  const streamed = _internals.buildRequestBody(CASE_ROW, { model: 'claude-test-model' });
  assert.equal(streamed.stream, true);

  const disabled = _internals.buildRequestBody(CASE_ROW, {
    model: 'claude-test-model',
    stream: false
  });
  assert.equal(Object.hasOwn(disabled, 'stream'), false);
});

test('readSseResponse accumulates text deltas + usage into a final payload', async () => {
  const response = sseResponse([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_stream_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test-model',
          usage: { input_tokens: 42, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      }
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"results":' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 88 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ]);

  const { events, payload } = await _internals.readSseResponse(response);
  assert.equal(events.length, 7);
  assert.equal(payload.id, 'msg_stream_1');
  assert.equal(payload.model, 'claude-test-model');
  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.usage.input_tokens, 42);
  assert.equal(payload.usage.output_tokens, 88);
  assert.equal(payload.content.length, 1);
  assert.equal(payload.content[0].type, 'text');
  assert.equal(payload.content[0].text, '{"results":[{"rank":1,"bluebook_citation":"13 Mich. 233"}]}');
});

test('executeCase parses streaming Anthropic response and scores via trustfoundry-legal-search', async () => {
  const providerResult = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'claude-test-model',
        api_key_env: 'ANTHROPIC_API_KEY',
        _fetch: async () => sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-test-model',
                usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
              }
            }
          },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"results":[{"rank":1,"title":"Schmittdiel","bluebook_citation":"13 Mich. 233"}]}' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } } },
          { event: 'message_stop', data: { type: 'message_stop' } }
        ])
      }
    })
  );

  assert.equal(providerResult.status, 'completed');
  assert.equal(providerResult.providerMetadata.streaming, true);
  assert.equal(providerResult.providerMetadata.sseEventCount, 6);
  assert.equal(providerResult.tokenUsage.inputTokens, 100);
  assert.equal(providerResult.tokenUsage.outputTokens, 50);
  const envelope = JSON.parse(providerResult.finalOutputText);
  assert.equal(envelope.results[0].bluebook_citation, '13 Mich. 233');
});

test('executeCase reports SSE stream_error when Anthropic emits an error event', async () => {
  const result = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'claude-test-model',
        api_key_env: 'ANTHROPIC_API_KEY',
        _fetch: async () => sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-test-model', usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
            }
          },
          { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Server temporarily overloaded' } } }
        ])
      }
    })
  );

  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'stream_error');
  assert.match(result.error.message, /overloaded/);
});

test('Claude-normalized Bluebook citation output scores with trustfoundry-legal-search scorer', async () => {
  const providerResult = await withEnv('ANTHROPIC_API_KEY', 'secret-key', () =>
    anthropicLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        model: 'claude-test-model',
        api_key_env: 'ANTHROPIC_API_KEY',
        _fetch: async () => anthropicResponse(JSON.stringify({
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
    manifest: { run_id: 'anthropic-test' },
    cases: [CASE_ROW],
    providerResults: [providerResult]
  });

  assert.equal(scores.caseScores[0].hitRank, 1);
  assert.equal(scores.summary.hitAt1, 1);
  assert.equal(scores.summary.hitAt25, 1);
});
