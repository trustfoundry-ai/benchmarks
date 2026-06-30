import assert from 'node:assert/strict';
import test from 'node:test';

import { _internals } from '../src/adapters/providers/trustfoundry-public-search.mjs';

test('requires model_type from config or row metadata and sends normalized state when enabled', () => {
  assert.throws(
    () => _internals.buildRequestBody({ caseId: 'c1', prompt: 'query', metadata: {} }, {}),
    /requires provider config model_type or row metadata\.model_type/
  );
  const body = _internals.buildRequestBody(
    {
      caseId: 'c1',
      prompt: 'query',
      metadata: { geo_level_2_identifier: 'mi' }
    },
    { model_type: 'case_question', state_filter_enabled: true }
  );
  assert.deepEqual(body, {
    query: 'query',
    model_type: 'case_question',
    state: 'MI'
  });
});

test('uses row model_type when provider config omits model_type', () => {
  const body = _internals.buildRequestBody(
    {
      caseId: 'c1',
      prompt: 'query',
      metadata: { model_type: 'law_question', geo_level_2_identifier: 'me' }
    },
    { state_filter_enabled: true }
  );
  assert.deepEqual(body, {
    query: 'query',
    model_type: 'law_question',
    state: 'ME'
  });
});

test('provider config model_type overrides row model_type', () => {
  const body = _internals.buildRequestBody(
    {
      caseId: 'c1',
      prompt: 'query',
      metadata: { model_type: 'law_question', geo_level_2_identifier: 'me' }
    },
    { model_type: 'case_question', state_filter_enabled: false }
  );
  assert.deepEqual(body, {
    query: 'query',
    model_type: 'case_question'
  });
});

test('omits limit from request body when not configured', () => {
  const body = _internals.buildRequestBody(
    {
      caseId: 'c1',
      prompt: 'query',
      metadata: { geo_level_2_identifier: 'mi' }
    },
    { model_type: 'case_question', state_filter_enabled: true }
  );
  assert.equal(Object.hasOwn(body, 'limit'), false);
});

test('forwards positive integer limit into request body', () => {
  const body = _internals.buildRequestBody(
    {
      caseId: 'c1',
      prompt: 'query',
      metadata: { geo_level_2_identifier: 'mi' }
    },
    { model_type: 'case_question', state_filter_enabled: true, limit: 25 }
  );
  assert.equal(body.limit, 25);
});

test('accepts camelCase and snake_case limit aliases', () => {
  const fromCamel = _internals.buildRequestBody(
    { caseId: 'c1', prompt: 'q', metadata: { geo_level_2_identifier: 'fed' } },
    { model_type: 'case_question', requestLimit: 10 }
  );
  const fromSnake = _internals.buildRequestBody(
    { caseId: 'c1', prompt: 'q', metadata: { geo_level_2_identifier: 'fed' } },
    { model_type: 'case_question', request_limit: 10 }
  );
  assert.equal(fromCamel.limit, 10);
  assert.equal(fromSnake.limit, 10);
});

test('drops non-positive or non-integer limit values', () => {
  for (const bad of [0, -3, 'twenty', null, undefined]) {
    const body = _internals.buildRequestBody(
      { caseId: 'c1', prompt: 'q', metadata: { geo_level_2_identifier: 'fed' } },
      { model_type: 'case_question', limit: bad }
    );
    assert.equal(
      Object.hasOwn(body, 'limit'),
      false,
      `limit=${String(bad)} should be dropped`
    );
  }
});

test('extracts SearchSet content from citations_ready events', () => {
  const searchSet = _internals.extractSearchSet([
    { type: 'status', content: 'running' },
    {
      type: 'citations_ready',
      content: JSON.stringify({
        uuid: 'set-1',
        search_results: [{
          document_uuid: '11111111-1111-1111-1111-111111111111',
          citation: '1 F.2d 3',
          citation_tag: '[Example Case - 1 F.2d 3](https://example.test)'
        }]
      })
    }
  ]);
  const envelope = _internals.normalizeEnvelope('query', searchSet);
  assert.equal(envelope.result_count, 1);
  assert.equal(envelope.results[0].document_uuid, '11111111-1111-1111-1111-111111111111');
  assert.equal(envelope.results[0].citation, '1 F.2d 3');
  assert.equal(envelope.results[0].citation_tag, '[Example Case - 1 F.2d 3](https://example.test)');
});

test('retry classification only retries transient provider failures', () => {
  assert.equal(
    _internals.isRetryableProviderFailure({
      status: 'provider_failure',
      error: { kind: 'http_error', status: 500 }
    }),
    true
  );
  assert.equal(
    _internals.isRetryableProviderFailure({
      status: 'provider_failure',
      error: { kind: 'stream_error', status: 200 }
    }),
    true
  );
  assert.equal(
    _internals.isRetryableProviderFailure({
      status: 'provider_failure',
      error: { kind: 'fetch_error', status: null }
    }),
    true
  );
  assert.equal(
    _internals.isRetryableProviderFailure({
      status: 'provider_failure',
      error: { kind: 'http_error', status: 400 }
    }),
    false
  );
  assert.equal(
    _internals.isRetryableProviderFailure({
      status: 'completed',
      error: null
    }),
    false
  );
});
