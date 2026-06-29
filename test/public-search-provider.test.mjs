import assert from 'node:assert/strict';
import test from 'node:test';

import { _internals } from '../src/adapters/providers/trustfoundry-public-search.mjs';

test('requires explicit model_type and sends normalized state when enabled', () => {
  assert.throws(
    () => _internals.buildRequestBody({ caseId: 'c1', prompt: 'query', metadata: {} }, {}),
    /requires explicit provider config model_type/
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
