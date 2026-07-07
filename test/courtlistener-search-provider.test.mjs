import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  courtlistenerSearchProviderAdapter,
  _internals as searchInternals
} from '../src/adapters/providers/courtlistener-search.mjs';
const TOKEN_ENV = 'COURTLISTENER_API_TOKEN_TEST';

// Point every test at a small fixture instead of the run-time-generated
// `data/courtlistener/court-jurisdictions.json` (which is not shipped —
// users generate it with scripts/build-cl-jurisdictions.mjs).
const JURISDICTION_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'cl-jurisdictions-fixture.json'
);

function baseConfig(overrides = {}) {
  const { jurisdiction_filter: filterOverride, ...restOverrides } = overrides;
  const cfg = {
    endpoint: 'https://cl.example.test/api/rest/v4/search/',
    token_env: TOKEN_ENV,
    request_timeout_ms: 30_000,
    page_size: 25,
    top_k: 25,
    rate_limits_docs_url: 'https://docs.example.test/rate-limits',
    rate_limits_fallback: { per_minute: 60, per_hour: 600, per_day: 6_000 },
    // Deep-merge jurisdiction_filter so callers can tweak mode / etc.
    // without losing the fixture mapping_path.
    jurisdiction_filter: {
      mapping_path: JURISDICTION_FIXTURE,
      ...(typeof filterOverride === 'object' && filterOverride ? filterOverride : {})
    },
    _rateLimitsSilent: true,
    _rateLimitsFetchFn: async () => ({ ok: false, status: 500, text: async () => '' }),
    _rateLimitsNow: () => 1_000_000,
    ...restOverrides
  };
  return cfg;
}

function baseCase(overrides = {}) {
  return {
    caseId: 'cl:test:1',
    prompt: 'Does Michigan recognize the fair-report privilege?',
    metadata: {
      geo_level_2_identifier: 'MI',
      state: 'MI',
      doc_type: 'case',
      expected: {
        canonical_citation: '13 Mich. 233',
        alternates: ['1865 Mich. LEXIS 19']
      }
    },
    ...overrides
  };
}

test('buildUrl always sends type=o, semantic=true, and page_size', () => {
  const url = searchInternals.buildUrl(
    'https://cl.example.test/api/rest/v4/search/',
    'privacy tort',
    { pageSize: 25, courtIds: [] }
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('type'), 'o');
  assert.equal(parsed.searchParams.get('q'), 'privacy tort');
  assert.equal(parsed.searchParams.get('page_size'), '25');
  assert.equal(parsed.searchParams.get('semantic'), 'true');
  assert.equal(parsed.searchParams.get('court'), null);
});

test('buildUrl joins court IDs with a space and sorts them', () => {
  const url = searchInternals.buildUrl(
    'https://cl.example.test/api/rest/v4/search/',
    'q',
    { pageSize: 25, courtIds: ['mi', 'ca9', 'mi'] }
  );
  assert.equal(new URL(url).searchParams.get('court'), 'ca9 mi');
});

test('buildUrl trims trailing unbalanced open paren to satisfy CL parser', () => {
  const raw = 'the church deed (1835); possession from 1844-1869; the remedy ("';
  const url = searchInternals.buildUrl(
    'https://cl.example.test/api/rest/v4/search/',
    raw,
    { pageSize: 25, courtIds: [] }
  );
  const q = new URL(url).searchParams.get('q');
  const opens = (q.match(/\(/g) || []).length;
  const closes = (q.match(/\)/g) || []).length;
  assert.equal(opens, closes, `expected balanced parens, got q=${q}`);
  // Balanced middle paren-pair stays intact.
  assert.ok(q.includes('(1835)'), `expected (1835) preserved, got: ${q}`);
});

test('buildUrl leaves balanced parens completely untouched', () => {
  const raw = 'contract (Oct. 17, 1873) supply columns (caps and girders); 46 days';
  const url = searchInternals.buildUrl(
    'https://cl.example.test/api/rest/v4/search/',
    raw,
    { pageSize: 25, courtIds: [] }
  );
  assert.equal(new URL(url).searchParams.get('q'), raw);
});

test('normalizeEnvelope produces citation + citations from multiple CL fields', () => {
  const envelope = searchInternals.normalizeEnvelope('q', {
    count: 3,
    results: [
      {
        id: 42,
        caseName: 'Doe v. Roe',
        citation: '13 Mich. 233',
        neutralCite: '2020 MI 42',
        lexisCite: '1865 Mich. LEXIS 19',
        absolute_url: '/opinion/42/doe-v-roe/',
        court_id: 'mi',
        dateFiled: '1865-01-01',
        snippet: '...fair report...'
      }
    ]
  }, { topK: 25 });
  assert.equal(envelope.result_count, 1);
  assert.equal(envelope.total_available, 3);
  const row = envelope.results[0];
  assert.equal(row.rank, 1);
  assert.equal(row.title, 'Doe v. Roe');
  assert.deepEqual(row.citations, ['13 Mich. 233', '2020 MI 42', '1865 Mich. LEXIS 19']);
  assert.equal(row.citation, '13 Mich. 233; 2020 MI 42; 1865 Mich. LEXIS 19');
  assert.equal(row.doc_id, '42');
  assert.equal(row.url, 'https://www.courtlistener.com/opinion/42/doe-v-roe/');
});

test('effectiveTopK defaults to config.limit then to 25', () => {
  assert.equal(searchInternals.effectiveTopK({ top_k: 10 }), 10);
  assert.equal(searchInternals.effectiveTopK({ limit: 15 }), 15);
  assert.equal(searchInternals.effectiveTopK({}), 25);
});

test('effectivePageSize is max(configured page_size, limit, topK)', () => {
  assert.equal(searchInternals.effectivePageSize({ page_size: 20, limit: 25 }, 25), 25);
  assert.equal(searchInternals.effectivePageSize({ page_size: 40 }, 25), 40);
  assert.equal(searchInternals.effectivePageSize({}, 25), 25);
});

test('describe surfaces semantic=true invariant, topK, pageSize, and rate limits', async () => {
  const config = baseConfig();
  const description = await courtlistenerSearchProviderAdapter.describe({ config });
  assert.equal(description.id, 'courtlistener-search');
  assert.equal(description.settings.semantic, true);
  assert.equal(description.settings.topK, 25);
  assert.equal(description.settings.pageSize, 25);
  assert.equal(description.settings.rateLimits.source, 'fallback');
  assert.deepEqual(description.settings.rateLimits.limits, {
    per_minute: 60,
    per_hour: 600,
    per_day: 6_000
  });
});

test('executeCase returns validation_error on empty query without hitting fetch or limiter', async () => {
  let fetchCalls = 0;
  const config = baseConfig({
    _fetch: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, text: async () => '{}', headers: new Map() };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase({ prompt: '' }),
    config
  });
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'validation_error');
  assert.equal(fetchCalls, 0);
});

test('executeCase sends semantic=true regardless of any config attempt to disable it', async () => {
  let observedUrl = null;
  const config = baseConfig({
    semantic: false, // must be ignored — semantic is an invariant
    _fetch: async (url) => {
      observedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            count: 1,
            results: [{ id: 1, caseName: 'X', citation: '13 Mich. 233' }]
          })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(result.status, 'completed');
  assert.equal(new URL(observedUrl).searchParams.get('semantic'), 'true');
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.results[0].citation, '13 Mich. 233');
});

test('executeCase filters to the case state courts even when config tries to disable', async () => {
  let observedUrl = null;
  const config = baseConfig({
    // These MUST be ignored — jurisdiction filtering is an invariant.
    jurisdiction_filter: { mode: 'none' },
    _fetch: async (url) => {
      observedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ count: 0, results: [] })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase({
      metadata: {
        geo_level_2_identifier: 'MI',
        state: 'MI',
        doc_type: 'case',
        expected: { canonical_citation: '13 Mich. 233', alternates: [] }
      }
    }),
    config
  });
  assert.equal(result.status, 'completed');
  const court = new URL(observedUrl).searchParams.get('court');
  assert.ok(court, `expected court= param, got URL ${observedUrl}`);
  const courtIds = court.split(' ');
  // state_appellate_supreme for MI should include the MI supreme court
  // (CL id 'mich') and an appellate court (michctapp).
  assert.ok(courtIds.includes('mich'), `expected 'mich' in court list, got ${court}`);
  assert.ok(courtIds.includes('michctapp'), `expected 'michctapp' in ${court}`);
  // Sanity: filter should NOT include federal courts for a MI case.
  assert.equal(courtIds.includes('scotus'), false);
});

test('executeCase FED case filters to federal courts, not any single state', async () => {
  let observedUrl = null;
  const config = baseConfig({
    _fetch: async (url) => {
      observedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ count: 0, results: [] })
      };
    }
  });
  await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase({
      metadata: {
        geo_level_2_identifier: 'FED',
        state: 'FED',
        doc_type: 'case',
        expected: { canonical_citation: '410 U.S. 113', alternates: [] }
      }
    }),
    config
  });
  const court = new URL(observedUrl).searchParams.get('court');
  assert.ok(court, `expected court= param on FED case`);
  const courtIds = court.split(' ');
  assert.ok(courtIds.includes('scotus'), `expected SCOTUS in FED court set, got ${court}`);
  // Should not include state supreme courts.
  assert.equal(courtIds.includes('mi'), false);
  assert.equal(courtIds.includes('nysup'), false);
});

test('describe reports the jurisdiction filter as an invariant', async () => {
  const description = await courtlistenerSearchProviderAdapter.describe({
    config: baseConfig()
  });
  assert.equal(description.settings.jurisdictionFilter.invariant, true);
  assert.equal(description.settings.jurisdictionFilter.mode, 'state_appellate_supreme');
});

test('executeCase records 429 as provider_failure with http_error kind', async () => {
  const config = baseConfig({
    _fetch: async () => ({
      ok: false,
      status: 429,
      // Use a retry-after well beyond MAX_RETRY_AFTER_MS to keep this test
      // synchronous — retry is skipped, matching pre-retry behavior.
      headers: new Map([['retry-after', '999999']]),
      text: async () => 'Too Many Requests'
    })
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  assert.equal(result.error.status, 429);
  assert.equal(result.rawOutput.retryAfter, '999999');
});

test('executeCase quota_exhausted short-circuits without calling fetch', async () => {
  let fetchCalls = 0;
  const config = baseConfig({
    rate_limits_fallback: { per_minute: 100, per_hour: 100, per_day: 1 },
    _fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ count: 0, results: [] })
      };
    }
  });

  // First call consumes the single per_day slot.
  const first = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase({ caseId: 'cl:test:a' }),
    config
  });
  assert.equal(first.status, 'completed');
  assert.equal(fetchCalls, 1);

  // Second call must short-circuit.
  const second = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase({ caseId: 'cl:test:b' }),
    config
  });
  assert.equal(second.status, 'provider_failure');
  assert.equal(second.error.kind, 'quota_exhausted');
  assert.equal(fetchCalls, 1);
});

test('executeCase writes a request+response audit artifact with token redacted', async () => {
  const previousToken = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = 'super-secret-token';
  try {
    const config = baseConfig({
      _fetch: async () => ({
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'application/json'],
          ['x-ratelimit-remaining', '4']
        ]),
        text: async () =>
          JSON.stringify({
            count: 1,
            results: [{ id: 42, caseName: 'X', citation: '13 Mich. 233' }]
          })
      })
    });
    const result = await courtlistenerSearchProviderAdapter.executeCase({
      benchmarkCase: baseCase(),
      config
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.artifacts.length, 1);
    const artifact = result.artifacts[0];
    assert.match(artifact.path, /^raw-responses\/cl_test_1\.json$/);
    const capture = JSON.parse(artifact.content);
    assert.equal(capture.schema_version, 'trustfoundry.benchmarks.courtlistener.capture.v2');
    assert.equal(capture.caseId, 'cl:test:1');
    assert.equal(capture.semantic, true);
    assert.ok(Array.isArray(capture.courtIds) && capture.courtIds.includes('mich'));
    // With only 1 result (below the 20-result cap), page 2 must be skipped.
    assert.equal(capture.pagination.pagesFetched, 1);
    assert.equal(capture.pagination.page2Skipped, true);
    assert.equal(capture.pagination.skipReason, 'page1_result_count_below_page_size');
    // Page 1 audit entry — reconstruct the call from just this file.
    const page1 = capture.pages[0];
    assert.equal(page1.page, 1);
    assert.equal(page1.request.method, 'GET');
    assert.match(page1.request.url, /semantic=true/);
    assert.equal(page1.request.cursor, null);
    // Auth header MUST be redacted, never contain the raw token.
    assert.equal(page1.request.headers.Authorization, '[REDACTED]');
    assert.equal(JSON.stringify(capture).includes('super-secret-token'), false);
    // Response verbatim body + headers preserved.
    assert.equal(page1.response.httpStatus, 200);
    assert.equal(page1.response.ok, true);
    assert.equal(page1.response.headers['content-type'], 'application/json');
    assert.equal(page1.response.headers['x-ratelimit-remaining'], '4');
    const bodyParsed = JSON.parse(page1.response.body);
    assert.equal(bodyParsed.count, 1);
    assert.equal(bodyParsed.results[0].id, 42);
    // The provider result also indexes the artifact path.
    assert.equal(
      result.providerMetadata.rawResponsePath,
      'raw-responses/cl_test_1.json'
    );
  } finally {
    if (previousToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previousToken;
  }
});

test('executeCase captures the response body for 429 errors (audit trail)', async () => {
  const config = baseConfig({
    _fetch: async () => ({
      ok: false,
      status: 429,
      // retry-after >> MAX_RETRY_AFTER_MS (15 min) → we won't retry, keeping
      // this test synchronous.
      headers: new Map([['retry-after', '999999']]),
      text: async () => '<html>Too Many Requests</html>'
    })
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  assert.equal(result.artifacts.length, 1);
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.pagesFetched, 1);
  assert.equal(capture.pagination.page2Skipped, true);
  assert.equal(capture.pagination.skipReason, 'page1_http_error');
  assert.equal(capture.pagination.retryAttempts, 0);
  const page1 = capture.pages[0];
  assert.equal(page1.page, 1);
  assert.equal(page1.attempt, 1);
  assert.equal(page1.response.httpStatus, 429);
  assert.equal(page1.response.body, '<html>Too Many Requests</html>');
  assert.equal(page1.response.headers['retry-after'], '999999');
});

test('executeCase retries page 1 on 429 with Retry-After, and a successful retry is treated as a normal hit', async () => {
  let call = 0;
  const config = baseConfig({
    _fetch: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', '0']]), // no-op sleep for test speed
          text: async () => '{"detail":"Request was throttled. Rate limit exceeded: 50/hour."}'
        };
      }
      // Retry succeeds.
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({ count: 1, results: [{ id: 42, cluster_id: '6751062', citation: ['13 Mich. 233'] }] })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  // Retry succeeded → case treated as a normal completion, scored via
  // page-2's absence (only 1 result, no cap fill).
  assert.equal(result.status, 'completed');
  assert.equal(call, 2);
  const capture = JSON.parse(result.artifacts[0].content);
  // Two attempts on page 1, both preserved in audit.
  assert.equal(capture.pagination.pagesFetched, 1);
  assert.equal(capture.pagination.retryAttempts, 1);
  assert.equal(capture.pages.length, 2);
  assert.equal(capture.pages[0].page, 1);
  assert.equal(capture.pages[0].attempt, 1);
  assert.equal(capture.pages[0].response.httpStatus, 429);
  assert.equal(capture.pages[1].page, 1);
  assert.equal(capture.pages[1].attempt, 2);
  assert.equal(capture.pages[1].response.httpStatus, 200);
  // The scorer sees the retry's data — this case would count as a hit if
  // the target matches, indistinguishable from a first-try success.
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 1);
  assert.equal(envelope.results[0].cluster_id, '6751062');
});

test('executeCase gives up when both attempts fail with 429 (case surfaces as provider_failure)', async () => {
  let call = 0;
  const config = baseConfig({
    _fetch: async () => {
      call += 1;
      return {
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '0']]),
        text: async () => 'Still throttled'
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(call, 2); // exactly one retry, then give up
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.retryAttempts, 1);
  assert.equal(capture.pages.length, 2);
  assert.equal(capture.pages[0].response.httpStatus, 429);
  assert.equal(capture.pages[1].response.httpStatus, 429);
});

test('executeCase skips retry when Retry-After exceeds the safety cap', async () => {
  let call = 0;
  const config = baseConfig({
    _fetch: async () => {
      call += 1;
      return {
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '99999']]), // > MAX_RETRY_AFTER_MS
        text: async () => 'Throttled'
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(call, 1); // no retry
  assert.equal(result.status, 'provider_failure');
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.retryAttempts, 0);
  assert.equal(capture.pages.length, 1);
});

test('executeCase retries page 2 independently of page 1', async () => {
  let call = 0;
  const config = baseConfig({
    _fetch: async () => {
      call += 1;
      if (call === 1) {
        // Page 1 succeeds and asks for page 2.
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () =>
            JSON.stringify({
              count: 500,
              next: 'https://www.courtlistener.com/api/rest/v4/search/?cursor=NEXT',
              results: Array.from({ length: 20 }, (_v, i) => ({
                id: 100 + i,
                cluster_id: `${100 + i}`,
                caseName: `Case ${i + 1}`
              }))
            })
        };
      }
      if (call === 2) {
        // Page 2 first attempt: 429
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', '0']]),
          text: async () => 'Throttled'
        };
      }
      // Page 2 retry: succeeds.
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            count: 500,
            next: null,
            results: Array.from({ length: 5 }, (_v, i) => ({
              id: 200 + i,
              cluster_id: `${200 + i}`,
              caseName: `Case ${21 + i}`
            }))
          })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(call, 3); // page 1 + page 2 attempt 1 + page 2 attempt 2
  assert.equal(result.status, 'completed');
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.pagesFetched, 2);
  assert.equal(capture.pagination.retryAttempts, 1);
  assert.equal(capture.pages.length, 3);
  assert.equal(capture.pages[0].page, 1);
  assert.equal(capture.pages[0].attempt, 1);
  assert.equal(capture.pages[1].page, 2);
  assert.equal(capture.pages[1].attempt, 1);
  assert.equal(capture.pages[1].response.httpStatus, 429);
  assert.equal(capture.pages[2].page, 2);
  assert.equal(capture.pages[2].attempt, 2);
  assert.equal(capture.pages[2].response.httpStatus, 200);
  // Combined envelope contains page 1 (20) + page 2 retry (5) = 25 results.
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 25);
});

test('retryAfterToMs parses seconds, rejects negative, unparseable, and over-cap', () => {
  assert.equal(searchInternals.retryAfterToMs('60'), 60_000);
  assert.equal(searchInternals.retryAfterToMs('0'), 0);
  assert.equal(searchInternals.retryAfterToMs(null), null);
  assert.equal(searchInternals.retryAfterToMs(''), null);
  assert.equal(searchInternals.retryAfterToMs('nope'), null);
  assert.equal(searchInternals.retryAfterToMs('-5'), null);
  // 99999 s = ~28 hours > 15-minute cap → null
  assert.equal(searchInternals.retryAfterToMs('99999'), null);
});

test('quota_exhausted short-circuit does NOT emit an artifact (no API call happened)', async () => {
  const config = baseConfig({
    rate_limits_fallback: { per_minute: 100, per_hour: 100, per_day: 1 },
    _fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify({ count: 0, results: [] })
    })
  });
  await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase({ caseId: 'cl:test:x' }),
    config
  });
  const short = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase({ caseId: 'cl:test:y' }),
    config
  });
  assert.equal(short.status, 'provider_failure');
  assert.equal(short.error.kind, 'quota_exhausted');
  assert.deepEqual(short.artifacts, []);
});

function fakeResult(index, cluster_id, citation = null) {
  return {
    id: 1000 + index,
    cluster_id,
    caseName: `Case ${index}`,
    citation: citation ? [citation] : [],
    court_id: 'mich',
    absolute_url: `/opinion/${cluster_id}/case-${index}/`,
    dateFiled: '2020-01-01'
  };
}

function twentyResults() {
  return Array.from({ length: 20 }, (_v, i) => fakeResult(i + 1, `mich-${i + 1}`));
}

test('extractCursor pulls cursor from CL next URL', () => {
  const cursor = searchInternals.extractCursor(
    'https://www.courtlistener.com/api/rest/v4/search/?cursor=abc123def&q=foo'
  );
  assert.equal(cursor, 'abc123def');
});

test('extractCursor returns null for missing or malformed URLs', () => {
  assert.equal(searchInternals.extractCursor(null), null);
  assert.equal(searchInternals.extractCursor(''), null);
  assert.equal(searchInternals.extractCursor('not a url'), null);
  assert.equal(
    searchInternals.extractCursor('https://www.courtlistener.com/api/rest/v4/search/?q=foo'),
    null
  );
});

test('executeCase fetches page 2 when page 1 fills the cap and next cursor is present', async () => {
  const fetchCalls = [];
  const config = baseConfig({
    _fetch: async (url) => {
      fetchCalls.push(url);
      if (fetchCalls.length === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () =>
            JSON.stringify({
              count: 500,
              next: 'https://www.courtlistener.com/api/rest/v4/search/?cursor=CURSOR_XYZ&q=foo',
              results: twentyResults()
            })
        };
      }
      // Page 2: 15 more results, no next.
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            count: 500,
            next: null,
            results: Array.from({ length: 15 }, (_v, i) => fakeResult(i + 21, `mich-${i + 21}`))
          })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(result.status, 'completed');
  assert.equal(fetchCalls.length, 2);
  // Page 2 URL must carry the cursor we extracted.
  assert.match(fetchCalls[1], /cursor=CURSOR_XYZ/);
  // Envelope contains ALL fetched results (35 total, not truncated to 25).
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 35);
  assert.equal(envelope.results.length, 35);
  // Ranks are sequential 1..35, page 1 first then page 2.
  assert.equal(envelope.results[0].rank, 1);
  assert.equal(envelope.results[19].rank, 20);
  assert.equal(envelope.results[20].rank, 21);
  assert.equal(envelope.results[34].rank, 35);
  // Audit capture records both pages.
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.pagesFetched, 2);
  assert.equal(capture.pagination.page2Skipped, false);
  assert.equal(capture.pages.length, 2);
  assert.equal(capture.pages[0].request.cursor, null);
  assert.equal(capture.pages[1].request.cursor, 'CURSOR_XYZ');
});

test('executeCase skips page 2 when page 1 returns fewer than 20 results (saves API budget)', async () => {
  let fetchCalls = 0;
  const config = baseConfig({
    _fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            count: 5,
            next: 'https://www.courtlistener.com/api/rest/v4/search/?cursor=abc',
            results: Array.from({ length: 5 }, (_v, i) => fakeResult(i + 1, `mich-${i + 1}`))
          })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(fetchCalls, 1);
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.pagesFetched, 1);
  assert.equal(capture.pagination.page2Skipped, true);
  assert.equal(capture.pagination.skipReason, 'page1_result_count_below_page_size');
});

test('executeCase skips page 2 when page 1 has 20 results but no next cursor', async () => {
  let fetchCalls = 0;
  const config = baseConfig({
    _fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({ count: 20, next: null, results: twentyResults() })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(fetchCalls, 1);
  assert.equal(result.status, 'completed');
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.skipReason, 'no_next_cursor');
});

test('executeCase skips page 2 when quota is exhausted between pages', async () => {
  let fetchCalls = 0;
  // Daily cap of 1 — first call fills the day, so page 2 is refused.
  const config = baseConfig({
    rate_limits_fallback: { per_minute: 100, per_hour: 100, per_day: 1 },
    _fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            count: 500,
            next: 'https://www.courtlistener.com/api/rest/v4/search/?cursor=abc',
            results: twentyResults()
          })
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(fetchCalls, 1);
  assert.equal(result.status, 'completed');
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.skipReason, 'quota_exhausted');
  // Page 1 results are still fully returned.
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 20);
});

test('executeCase returns page 1 results even when page 2 errors', async () => {
  let call = 0;
  const config = baseConfig({
    _fetch: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () =>
            JSON.stringify({
              count: 500,
              next: 'https://www.courtlistener.com/api/rest/v4/search/?cursor=abc',
              results: twentyResults()
            })
        };
      }
      return {
        ok: false,
        status: 500,
        headers: new Map(),
        text: async () => 'Server Error'
      };
    }
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  // Page 2 failing does NOT fail the case — page 1's results are still scorable.
  assert.equal(result.status, 'completed');
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.result_count, 20);
  const capture = JSON.parse(result.artifacts[0].content);
  assert.equal(capture.pagination.pagesFetched, 2);
  assert.equal(capture.pagination.page2Error.kind, 'http_error');
  assert.equal(capture.pagination.page2Error.status, 500);
  assert.equal(capture.pages[1].response.httpStatus, 500);
});

test('executeCase envelope shape is compatible with the raw-row schema', async () => {
  const config = baseConfig({
    _fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () =>
        JSON.stringify({
          count: 2,
          results: [
            {
              id: 42,
              caseName: 'Doe v. Roe',
              citation: '13 Mich. 233',
              absolute_url: '/opinion/42/doe-v-roe/'
            },
            { id: 43, caseName: 'X v. Y', citation: '14 Mich. 500' }
          ]
        })
    })
  });
  const result = await courtlistenerSearchProviderAdapter.executeCase({
    benchmarkCase: baseCase(),
    config
  });
  assert.equal(result.status, 'completed');
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.query, 'Does Michigan recognize the fair-report privilege?');
  assert.equal(envelope.result_count, 2);
  assert.equal(envelope.total_available, 2);
  assert.equal(envelope.results[0].rank, 1);
  assert.deepEqual(envelope.results[0].citations, ['13 Mich. 233']);
});
