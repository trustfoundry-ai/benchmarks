import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Point the court-url-map loader at the extended fixture (SCOTUS +
// federal circuits + a few state supreme courts) so tests that use
// `authority_identifier: 'mich'` still resolve to the expected hosts.
// Set BEFORE importing the adapter, which imports court-url-map at
// module-eval time.
process.env.TF_COURT_URLS_CSV = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'court-url-map-fixture.csv'
);

const { parallelLegalSearchProviderAdapter, _internals } = await import(
  '../src/adapters/providers/parallel-legal-search.mjs'
);

const CASE_ROW = {
  caseId: 'trustfoundry-legal-search:case_questions:test:mich01',
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
    document_title: 'People ex rel. Schmittdiel v. Board of Auditors',
    expected: {
      canonical_citation: '13 Mich. 233',
      alternates: ['1865 Mich. LEXIS 19'],
      cl_cluster_id: '6751062'
    }
  }
};

function parallelResponse(results, extra = {}) {
  return new Response(JSON.stringify({
    search_id: 'search_test_123',
    session_id: 'session_test_456',
    results,
    ...extra
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

async function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// -----------------------------------------------------------------------
// Request-body construction
// -----------------------------------------------------------------------

test('buildRequestBody uses row prompt in question mode + primary hosts', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'primary_only',
    top_k: 25
  });
  assert.deepEqual(body.search_queries, ['Analyze exclusive county control doctrine.']);
  assert.equal(body.mode, 'advanced');
  assert.equal(body.advanced_settings.max_results, 25);
  assert.deepEqual(body.advanced_settings.source_policy.include_domains, ['courts.michigan.gov']);
  assert.equal(body.objective, _internals.DEFAULT_OBJECTIVE);
});

test('buildRequestBody title mode uses document_title + canonical_citation', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'title',
    domain_scope: 'primary_only'
  });
  assert.deepEqual(
    body.search_queries,
    ['People ex rel. Schmittdiel v. Board of Auditors 13 Mich. 233']
  );
});

test('buildRequestBody primary_plus_aggregators adds the default aggregator list', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'primary_plus_aggregators'
  });
  const domains = body.advanced_settings.source_policy.include_domains;
  assert.ok(domains.includes('courts.michigan.gov'));
  assert.ok(domains.includes('courtlistener.com'));
  assert.ok(domains.includes('law.justia.com'));
});

test('buildRequestBody aggregators_only ignores per-row court scoping and returns the aggregator list', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'aggregators_only'
  });
  const domains = body.advanced_settings.source_policy.include_domains;
  assert.equal(domains.includes('courts.michigan.gov'), false);
  assert.ok(domains.includes('courtlistener.com'));
  assert.ok(domains.includes('law.justia.com'));
});

test('buildRequestBody aggregators_only honors config-supplied aggregator_hosts override', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'aggregators_only',
    aggregator_hosts: ['courtlistener.com', 'law.justia.com']
  });
  assert.deepEqual(
    body.advanced_settings.source_policy.include_domains,
    ['courtlistener.com', 'law.justia.com']
  );
});

test('buildRequestBody unrestricted omits include_domains entirely', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'unrestricted'
  });
  const sourcePolicy = body.advanced_settings?.source_policy ?? {};
  assert.equal(Object.hasOwn(sourcePolicy, 'include_domains'), false);
});

test('buildRequestBody honors exclude_domains from config', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'primary_only',
    exclude_domains: ['casemine.com', 'vlex.com']
  });
  assert.deepEqual(
    body.advanced_settings.source_policy.exclude_domains,
    ['casemine.com', 'vlex.com']
  );
});

test('buildRequestBody honors search_mode = turbo | basic | advanced', () => {
  const turbo = _internals.buildRequestBody(CASE_ROW, { search_mode: 'turbo' });
  assert.equal(turbo.mode, 'turbo');
  const basic = _internals.buildRequestBody(CASE_ROW, { search_mode: 'basic' });
  assert.equal(basic.mode, 'basic');
});

test('buildRequestBody omits objective when configured to null', () => {
  const body = _internals.buildRequestBody(CASE_ROW, { objective: null });
  assert.equal(Object.hasOwn(body, 'objective'), false);
});

test('buildRequestBody throws config_error on invalid query_mode / domain_scope / mode', () => {
  assert.throws(
    () => _internals.buildRequestBody(CASE_ROW, { query_mode: 'bogus' }),
    /unknown query_mode/
  );
  assert.throws(
    () => _internals.buildRequestBody(CASE_ROW, { domain_scope: 'bogus' }),
    /unknown domain_scope/
  );
  assert.throws(
    () => _internals.buildRequestBody(CASE_ROW, { search_mode: 'bogus' }),
    /unknown mode/
  );
});

test('buildRequestBody rejects non-case rows', () => {
  assert.throws(
    () => _internals.buildRequestBody({
      caseId: 'x',
      prompt: 'law question',
      metadata: { doc_type: 'law', model_type: 'law_question' }
    }, {}),
    /only supports case rows/
  );
});

// -----------------------------------------------------------------------
// Envelope normalization + citation extraction
// -----------------------------------------------------------------------

test('normalizeParallelResult strongHit=true when URL cross-refs gold cl_cluster_id', () => {
  const r = _internals.normalizeParallelResult(
    {
      url: 'https://www.courtlistener.com/opinion/6751062/people-schmittdiel/',
      title: 'People ex rel. Schmittdiel',
      publish_date: '1865-01-01',
      excerpts: []
    },
    CASE_ROW.metadata.expected,
    0
  );
  assert.equal(r._evidence.strongHit, true);
  assert.equal(r._evidence.urlMatchesGold, true);
  assert.equal(r.citation, '13 Mich. 233');
  assert.equal(r.publisher, 'CourtListener');
  assert.equal(r.date, '1865-01-01');
});

test('normalizeParallelResult populates citation on caption-class excerpt match', () => {
  const r = _internals.normalizeParallelResult(
    {
      url: 'https://law.justia.com/cases/michigan/supreme-court/1865/x-y.html',
      title: 'Schmittdiel v Board of Auditors',
      excerpts: [
        'People ex rel. Schmittdiel v. Board of Auditors, 13 Mich. 233 (1865). The doctrine...'
      ]
    },
    CASE_ROW.metadata.expected,
    3
  );
  assert.equal(r._evidence.strongHit, true);
  assert.equal(r.citation, '13 Mich. 233');
  assert.deepEqual(r.citations, ['13 Mich. 233']);
});

test('normalizeParallelResult leaves citation null on reference-only excerpt match', () => {
  const r = _internals.normalizeParallelResult(
    {
      url: 'https://law.justia.com/cases/michigan/supreme-court/1971/386-mich-1-2.html',
      title: 'Wayne Circuit Judges v. Wayne County',
      excerpts: [
        'The court, citing 13 Mich. 233, held that county control extends to...'
      ]
    },
    CASE_ROW.metadata.expected,
    5
  );
  assert.equal(r._evidence.strongHit, false, 'reference match should NOT be strong hit');
  assert.equal(r._evidence.looseHit, true);
  assert.equal(r.citation, null);
  assert.deepEqual(r.citations, []);
});

test('normalizeParallelResult joins multiple excerpts into a single excerpt string', () => {
  const r = _internals.normalizeParallelResult(
    {
      url: 'https://law.justia.com/x.html',
      title: 'x',
      excerpts: ['first snippet', 'second snippet']
    },
    CASE_ROW.metadata.expected,
    0
  );
  assert.equal(r.excerpt, 'first snippet … second snippet');
});

test('summarizeExtraction aggregates parsers, hosts, context class breakdown', () => {
  const envelope = _internals.normalizeEnvelope(
    'query text',
    [
      { url: 'https://www.courtlistener.com/opinion/6751062/x/', title: '', excerpts: [] },
      { url: 'https://law.justia.com/cases/michigan/supreme-court/1865/x.html',
        title: 'Schmittdiel', excerpts: ['People v. Auditors, 13 Mich. 233 (1865).'] },
      { url: 'https://law.justia.com/cases/michigan/supreme-court/1971/y.html',
        title: 'Wayne', excerpts: ['citing 13 Mich. 233'] },
      { url: 'https://random-unknown-host.example.com/x', title: '', excerpts: [] }
    ],
    CASE_ROW.metadata.expected,
    { topK: 25 }
  );
  const s = _internals.summarizeExtraction(envelope);
  assert.equal(s.strongHitCount, 2);
  assert.equal(s.looseHitCount, 3, 'strong hits + the reference-only row count as loose');
  assert.equal(s.firstStrongHitRank, 1);
  assert.equal(s.contextClasses.caption >= 1, true);
  assert.equal(s.contextClasses.reference >= 1, true);
  assert.ok(s.byParser.courtlistener_opinion >= 1);
  assert.ok(s.unmatchedHosts.includes('random-unknown-host.example.com'));
});

// -----------------------------------------------------------------------
// executeCase — full path
// -----------------------------------------------------------------------

test('executeCase returns completed envelope with correct metadata on a strong hit', async () => {
  const calls = [];
  const result = await withEnv('PARALLEL_API_KEY', 'test-key', () =>
    parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        query_mode: 'title',
        domain_scope: 'primary_plus_aggregators',
        search_mode: 'advanced',
        _fetch: async (url, init) => {
          calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
          return parallelResponse([
            {
              url: 'https://www.courtlistener.com/opinion/6751062/people-schmittdiel/',
              title: 'People ex rel. Schmittdiel v. Board of Auditors',
              publish_date: '1865-01-01',
              excerpts: ['People v. Auditors, 13 Mich. 233 (1865). Doctrine established here.']
            },
            {
              url: 'https://law.justia.com/cases/michigan/supreme-court/1971/386-mich-1-2.html',
              title: 'Wayne Circuit',
              excerpts: ['See 13 Mich. 233, applying county control doctrine.']
            }
          ]);
        }
      }
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.parallel.ai/v1/search');
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.equal(calls[0].body.search_queries[0].includes('13 Mich. 233'), true);
  assert.equal(calls[0].body.mode, 'advanced');

  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 2);
  assert.equal(envelope.results[0].citation, '13 Mich. 233');
  assert.equal(envelope.results[1].citation, null, 'reference-only hit must not populate citation');
  assert.equal(result.providerMetadata.queryMode, 'title');
  assert.equal(result.providerMetadata.domainScope, 'primary_plus_aggregators');
  assert.equal(result.providerMetadata.searchMode, 'advanced');
  assert.equal(result.providerMetadata.extraction.strongHitCount, 1);
  assert.equal(result.providerMetadata.extraction.contextClasses.reference >= 1, true);
  assert.equal(result.rawOutput.searchId, 'search_test_123');
  assert.equal(result.rawOutput.sessionId, 'session_test_456');
});

test('executeCase redacts the api key from the recorded request headers', async () => {
  const result = await withEnv('PARALLEL_API_KEY', 'secret-key-do-not-leak', () =>
    parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        _fetch: async () => parallelResponse([{
          url: 'https://www.courtlistener.com/opinion/6751062/x/',
          title: 't',
          excerpts: []
        }])
      }
    })
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.rawOutput.request.headers['x-api-key'], '[REDACTED]');
  assert.equal(JSON.stringify(result).includes('secret-key-do-not-leak'), false);
});

test('executeCase surfaces config_error when PARALLEL_API_KEY is missing', async () => {
  const prev = process.env.PARALLEL_API_KEY;
  delete process.env.PARALLEL_API_KEY;
  try {
    const result = await parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: { _fetch: async () => { throw new Error('unexpected'); } }
    });
    assert.equal(result.status, 'provider_failure');
    assert.equal(result.error.kind, 'config_error');
    assert.match(result.error.message, /PARALLEL_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.PARALLEL_API_KEY = prev;
  }
});

test('executeCase surfaces missing_results when Parallel returns an empty results array', async () => {
  const result = await withEnv('PARALLEL_API_KEY', 'test-key', () =>
    parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: { _fetch: async () => parallelResponse([]) }
    })
  );
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'missing_results');
});

test('executeCase classifies 5xx as http_error (not retried)', async () => {
  let calls = 0;
  const result = await withEnv('PARALLEL_API_KEY', 'test-key', () =>
    parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        _fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({
            type: 'error',
            error: { ref_id: 'r1', message: 'internal' }
          }), { status: 502 });
        }
      }
    })
  );
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  assert.equal(result.error.status, 502);
  assert.equal(calls, 1);
});

test('executeCase classifies 422 validation errors as http_error and surfaces error.message', async () => {
  const result = await withEnv('PARALLEL_API_KEY', 'test-key', () =>
    parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        _fetch: async () => new Response(JSON.stringify({
          type: 'error',
          error: { ref_id: 'r2', message: 'search_queries must be 3-6 words each' }
        }), { status: 422 })
      }
    })
  );
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  assert.equal(result.error.status, 422);
  assert.match(result.error.message, /3-6 words/);
});

test('executeCase retries client-side fetch_error once and then succeeds', async () => {
  let calls = 0;
  const result = await withEnv('PARALLEL_API_KEY', 'test-key', () =>
    parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        _fetch: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error('getaddrinfo ENOTFOUND api.parallel.ai');
            err.name = 'TypeError';
            throw err;
          }
          return parallelResponse([{
            url: 'https://www.courtlistener.com/opinion/6751062/x/',
            title: 't',
            excerpts: []
          }]);
        }
      }
    })
  );
  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(result.retryMetadata.retryCount, 1);
});

test('executeCase classifies timeout error as timeout (not retried)', async () => {
  let calls = 0;
  const result = await withEnv('PARALLEL_API_KEY', 'test-key', () =>
    parallelLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
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
  assert.equal(calls, 1);
});

test('describe returns settings + supported model types', async () => {
  const desc = await parallelLegalSearchProviderAdapter.describe({
    config: { query_mode: 'question', domain_scope: 'primary_only', search_mode: 'basic' }
  });
  assert.equal(desc.id, 'parallel-legal-search');
  assert.equal(desc.settings.queryMode, 'question');
  assert.equal(desc.settings.domainScope, 'primary_only');
  assert.equal(desc.settings.searchMode, 'basic');
  assert.deepEqual(desc.settings.supportedModelTypes.sort(), ['case_key_fact', 'case_question']);
});
