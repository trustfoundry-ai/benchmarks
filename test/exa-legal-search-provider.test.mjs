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

const { exaLegalSearchProviderAdapter, _internals } = await import(
  '../src/adapters/providers/exa-legal-search.mjs'
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

function exaResponse(results, extra = {}) {
  return new Response(JSON.stringify({
    searchId: 'search_test_123',
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
  assert.equal(body.query, 'Analyze exclusive county control doctrine.');
  assert.equal(body.numResults, 25);
  assert.equal(body.type, 'auto');
  assert.deepEqual(body.includeDomains, ['courts.michigan.gov']);
  assert.equal(body.contents.highlights.numSentences, 3);
});

test('buildRequestBody title mode uses document_title + canonical_citation', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'title',
    domain_scope: 'primary_only'
  });
  assert.equal(
    body.query,
    'People ex rel. Schmittdiel v. Board of Auditors 13 Mich. 233'
  );
});

test('buildRequestBody primary_plus_aggregators adds the default aggregator list', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'primary_plus_aggregators'
  });
  assert.ok(body.includeDomains.includes('courts.michigan.gov'));
  assert.ok(body.includeDomains.includes('courtlistener.com'));
  assert.ok(body.includeDomains.includes('law.justia.com'));
});

test('buildRequestBody aggregators_only ignores per-row court scoping and returns the aggregator list', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'aggregators_only'
  });
  // No primary court host — Michigan (`mich`, courts.michigan.gov) is NOT in includeDomains.
  assert.equal(body.includeDomains.includes('courts.michigan.gov'), false);
  // Aggregators are present.
  assert.ok(body.includeDomains.includes('courtlistener.com'));
  assert.ok(body.includeDomains.includes('law.justia.com'));
});

test('buildRequestBody aggregators_only honors config-supplied aggregator_hosts override', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'aggregators_only',
    aggregator_hosts: ['courtlistener.com', 'law.justia.com']
  });
  assert.deepEqual(body.includeDomains, ['courtlistener.com', 'law.justia.com']);
});

test('buildRequestBody unrestricted omits includeDomains entirely', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'unrestricted'
  });
  assert.equal(Object.hasOwn(body, 'includeDomains'), false);
});

test('buildRequestBody honors excludeDomains from config', () => {
  const body = _internals.buildRequestBody(CASE_ROW, {
    query_mode: 'question',
    domain_scope: 'primary_only',
    exclude_domains: ['casemine.com', 'vlex.com']
  });
  assert.deepEqual(body.excludeDomains, ['casemine.com', 'vlex.com']);
});

test('buildRequestBody throws config_error on invalid query_mode / domain_scope', () => {
  assert.throws(
    () => _internals.buildRequestBody(CASE_ROW, { query_mode: 'bogus' }),
    /unknown query_mode/
  );
  assert.throws(
    () => _internals.buildRequestBody(CASE_ROW, { domain_scope: 'bogus' }),
    /unknown domain_scope/
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

test('normalizeExaResult strongHit=true when URL cross-refs gold cl_cluster_id', () => {
  const r = _internals.normalizeExaResult(
    {
      url: 'https://www.courtlistener.com/opinion/6751062/people-schmittdiel/',
      title: 'People ex rel. Schmittdiel',
      publishedDate: '1865-01-01',
      highlights: []
    },
    CASE_ROW.metadata.expected,
    0
  );
  assert.equal(r._evidence.strongHit, true);
  assert.equal(r._evidence.urlMatchesGold, true);
  assert.equal(r.citation, '13 Mich. 233');
  assert.equal(r.publisher, 'CourtListener');
});

test('normalizeExaResult populates citation on caption-class excerpt match', () => {
  const r = _internals.normalizeExaResult(
    {
      url: 'https://law.justia.com/cases/michigan/supreme-court/1865/x-y.html',
      title: 'Schmittdiel v Board of Auditors',
      highlights: [
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

test('normalizeExaResult leaves citation null on reference-only excerpt match', () => {
  const r = _internals.normalizeExaResult(
    {
      url: 'https://law.justia.com/cases/michigan/supreme-court/1971/386-mich-1-2.html',
      title: 'Wayne Circuit Judges v. Wayne County',
      highlights: [
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

test('summarizeExtraction aggregates parsers, hosts, context class breakdown', () => {
  const envelope = _internals.normalizeEnvelope(
    'query text',
    [
      { url: 'https://www.courtlistener.com/opinion/6751062/x/', title: '', highlights: [] },
      { url: 'https://law.justia.com/cases/michigan/supreme-court/1865/x.html',
        title: 'Schmittdiel', highlights: ['People v. Auditors, 13 Mich. 233 (1865).'] },
      { url: 'https://law.justia.com/cases/michigan/supreme-court/1971/y.html',
        title: 'Wayne', highlights: ['citing 13 Mich. 233'] },
      { url: 'https://random-unknown-host.example.com/x', title: '', highlights: [] }
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
  const result = await withEnv('EXA_API_KEY', 'test-key', () =>
    exaLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        query_mode: 'title',
        domain_scope: 'primary_plus_aggregators',
        _fetch: async (url, init) => {
          calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
          return exaResponse([
            {
              url: 'https://www.courtlistener.com/opinion/6751062/people-schmittdiel/',
              title: 'People ex rel. Schmittdiel v. Board of Auditors',
              publishedDate: '1865-01-01',
              highlights: ['People v. Auditors, 13 Mich. 233 (1865). Doctrine established here.']
            },
            {
              url: 'https://law.justia.com/cases/michigan/supreme-court/1971/386-mich-1-2.html',
              title: 'Wayne Circuit',
              highlights: ['See 13 Mich. 233, applying county control doctrine.']
            }
          ]);
        }
      }
    })
  );

  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.exa.ai/search');
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.equal(calls[0].body.query.includes('13 Mich. 233'), true);

  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 2);
  assert.equal(envelope.results[0].citation, '13 Mich. 233');
  assert.equal(envelope.results[1].citation, null, 'reference-only hit must not populate citation');
  assert.equal(result.providerMetadata.queryMode, 'title');
  assert.equal(result.providerMetadata.domainScope, 'primary_plus_aggregators');
  assert.equal(result.providerMetadata.extraction.strongHitCount, 1);
  assert.equal(result.providerMetadata.extraction.contextClasses.reference >= 1, true);
});

test('executeCase surfaces config_error when EXA_API_KEY is missing', async () => {
  const prev = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    const result = await exaLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: { _fetch: async () => { throw new Error('unexpected'); } }
    });
    assert.equal(result.status, 'provider_failure');
    assert.equal(result.error.kind, 'config_error');
    assert.match(result.error.message, /EXA_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.EXA_API_KEY = prev;
  }
});

test('executeCase surfaces missing_results when Exa returns an empty results array', async () => {
  const result = await withEnv('EXA_API_KEY', 'test-key', () =>
    exaLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: { _fetch: async () => exaResponse([]) }
    })
  );
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'missing_results');
});

test('executeCase classifies 5xx as http_error (not retried)', async () => {
  let calls = 0;
  const result = await withEnv('EXA_API_KEY', 'test-key', () =>
    exaLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        _fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { message: 'internal' } }), { status: 502 });
        }
      }
    })
  );
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  assert.equal(result.error.status, 502);
  assert.equal(calls, 1);
});

test('executeCase retries client-side fetch_error once and then succeeds', async () => {
  let calls = 0;
  const result = await withEnv('EXA_API_KEY', 'test-key', () =>
    exaLegalSearchProviderAdapter.executeCase({
      benchmarkCase: CASE_ROW,
      config: {
        _fetch: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error('getaddrinfo ENOTFOUND api.exa.ai');
            err.name = 'TypeError';
            throw err;
          }
          return exaResponse([{
            url: 'https://www.courtlistener.com/opinion/6751062/x/',
            title: 't',
            highlights: []
          }]);
        }
      }
    })
  );
  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(result.retryMetadata.retryCount, 1);
});

test('describe returns settings + supported model types', async () => {
  const desc = await exaLegalSearchProviderAdapter.describe({
    config: { query_mode: 'question', domain_scope: 'primary_only' }
  });
  assert.equal(desc.id, 'exa-legal-search');
  assert.equal(desc.settings.queryMode, 'question');
  assert.equal(desc.settings.domainScope, 'primary_only');
  assert.deepEqual(desc.settings.supportedModelTypes.sort(), ['case_key_fact', 'case_question']);
});
