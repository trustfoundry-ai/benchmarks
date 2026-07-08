import assert from 'node:assert/strict';
import test from 'node:test';

import {
  courtlistenerCitationLookupProviderAdapter,
  _internals
} from '../src/adapters/providers/courtlistener-citation-lookup.mjs';

const BASE_CASE = {
  caseId: 'citation-lookup-cases:fed-akb-0001',
  benchmarkId: 'citation-lookup-cases',
  prompt: '410 U.S. 113',
  metadata: {
    expected: {
      canonical_citation: '410 U.S. 113',
      cl_cluster_id: '108713'
    }
  }
};

function fakeHeaders(entries = []) {
  const map = new Map(entries);
  return {
    get(name) {
      return map.get(String(name).toLowerCase()) ?? null;
    },
    entries() {
      return map.entries();
    }
  };
}

function mkResponse({ status = 200, ok, body, headers = [] } = {}) {
  const httpOk = ok ?? (status >= 200 && status < 300);
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? []);
  return {
    ok: httpOk,
    status,
    headers: fakeHeaders(headers.map(([k, v]) => [k.toLowerCase(), v])),
    async text() {
      return text;
    }
  };
}

function baseConfig(overrides = {}) {
  return {
    endpoint: 'https://example.test/api/rest/v4/citation-lookup/',
    request_timeout_ms: 1000,
    _rateLimitsSilent: true,
    _rateLimitsNow: () => 0,
    _rateLimitsFetchFn: async () => ({
      ok: false,
      status: 500,
      async text() { return ''; }
    }),
    ...overrides
  };
}

test('happy path: single cluster (status 200)', async () => {
  const captured = [];
  const config = baseConfig({
    _fetch: async (url, init) => {
      captured.push({ url, init });
      return mkResponse({
        status: 200,
        body: [
          {
            citation: '410 U.S. 113',
            normalized_citations: ['410 U.S. 113'],
            status: 200,
            clusters: [
              {
                id: 108713,
                case_name: 'Roe v. Wade',
                citations: [{ volume: 410, reporter: 'U.S.', page: 113 }],
                absolute_url: '/opinion/108713/roe-v-wade/',
                court_id: 'scotus',
                date_filed: '1973-01-22'
              }
            ]
          }
        ]
      });
    }
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.error, null);
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.status, 200);
  assert.equal(envelope.provider_ambiguous, false);
  assert.equal(envelope.results.length, 1);
  assert.equal(envelope.results[0].rank, 1);
  assert.equal(envelope.results[0].cluster_id, '108713');
  assert.equal(envelope.results[0].case_name, 'Roe v. Wade');
  assert.deepEqual(envelope.results[0].citations, ['410 U.S. 113']);
  assert.equal(
    envelope.results[0].url,
    'https://www.courtlistener.com/opinion/108713/roe-v-wade/'
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].init.method, 'POST');
  assert.equal(captured[0].init.headers['Content-Type'], 'application/json');
  assert.equal(captured[0].init.body, JSON.stringify({ text: '410 U.S. 113' }));
});

test('ambiguous: status 300 with 3 candidate clusters', async () => {
  const config = baseConfig({
    _fetch: async () =>
      mkResponse({
        status: 200,
        body: [
          {
            citation: '5 F.3d 100',
            normalized_citations: ['5 F.3d 100'],
            status: 300,
            clusters: [
              { id: 1, case_name: 'Alpha v. Beta', absolute_url: '/opinion/1/a/' },
              { id: 2, case_name: 'Gamma v. Delta', absolute_url: '/opinion/2/b/' },
              { id: 3, case_name: 'Epsilon v. Zeta', absolute_url: '/opinion/3/c/' }
            ]
          }
        ]
      })
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: { ...BASE_CASE, prompt: '5 F.3d 100' },
    config
  });

  assert.equal(result.status, 'completed');
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.status, 300);
  assert.equal(envelope.provider_ambiguous, true);
  assert.equal(envelope.results.length, 3);
  assert.deepEqual(envelope.results.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(envelope.results.map((r) => r.cluster_id), ['1', '2', '3']);
});

test('non-citation input: empty top-level array yields null status', async () => {
  const config = baseConfig({
    _fetch: async () => mkResponse({ status: 200, body: [] })
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: { ...BASE_CASE, prompt: 'ordinary paragraph with no citation' },
    config
  });

  assert.equal(result.status, 'completed');
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.status, null);
  assert.deepEqual(envelope.results, []);
  assert.deepEqual(envelope.normalized_citations, []);
});

test('per-item status 404: completed with empty results', async () => {
  const config = baseConfig({
    _fetch: async () =>
      mkResponse({
        status: 200,
        body: [
          {
            citation: '999 U.S. 999',
            normalized_citations: ['999 U.S. 999'],
            status: 404,
            error_message: 'Citation not found',
            clusters: []
          }
        ]
      })
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: { ...BASE_CASE, prompt: '999 U.S. 999' },
    config
  });

  assert.equal(result.status, 'completed');
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.status, 404);
  assert.deepEqual(envelope.results, []);
  assert.equal(envelope.error_message, 'Citation not found');
});

test('HTTP 429 with Retry-After: sleep + retry using the header value, then succeed', async () => {
  let calls = 0;
  const config = baseConfig({
    _fetch: async () => {
      calls += 1;
      if (calls === 1) {
        // First call returns 429 with a short Retry-After — the adapter should
        // sleep for the header value and retry rather than fail immediately.
        return mkResponse({
          status: 429,
          body: '{"detail":"Rate limit exceeded"}',
          headers: [['retry-after', '0']]
        });
      }
      return mkResponse({
        status: 200,
        body: [
          {
            citation: '410 U.S. 113',
            status: 200,
            clusters: [{ id: 108713, case_name: 'Roe v. Wade' }]
          }
        ]
      });
    }
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'completed');
  const envelope = JSON.parse(result.finalOutputText);
  assert.equal(envelope.results.length, 1);
  assert.equal(envelope.results[0].cluster_id, '108713');
});

test('HTTP 429 exhausts the rate-limit retry budget → provider_failure kind rate_limited', async () => {
  let calls = 0;
  const config = baseConfig({
    _fetch: async () => {
      calls += 1;
      return mkResponse({
        status: 429,
        body: '{"detail":"Rate limit exceeded"}',
        headers: [['retry-after', '0']]
      });
    }
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });

  // MAX_RATE_LIMIT_RETRIES = 2 → 3 total attempts before giving up
  assert.equal(calls, 3);
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'rate_limited');
  assert.equal(result.error.status, 429);
});

test('HTTP 500: retries once then surfaces provider_failure http_error', async () => {
  let calls = 0;
  const config = baseConfig({
    _fetch: async () => {
      calls += 1;
      return mkResponse({ status: 500, body: '' });
    }
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'http_error');
  assert.equal(result.error.status, 500);
  assert.equal(result.retryMetadata?.retried, true);
});

test('Fetch throws: retries once then surfaces provider_failure fetch_error', async () => {
  let calls = 0;
  const config = baseConfig({
    _fetch: async () => {
      calls += 1;
      throw new TypeError('network refused');
    }
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });

  assert.equal(calls, 2);
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'fetch_error');
  assert.match(result.error.message, /network refused/);
});

test('Empty prompt: short-circuits with validation_error and no fetch', async () => {
  let calls = 0;
  const config = baseConfig({
    _fetch: async () => {
      calls += 1;
      return mkResponse({ status: 200, body: [] });
    }
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: { ...BASE_CASE, prompt: '' },
    config
  });

  assert.equal(calls, 0);
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'validation_error');
});

test('Authorization header appears only when env var is set', async () => {
  let capturedHeaders = null;
  const config = baseConfig({
    token_env: 'CL_TEST_TOKEN_ENV_VAR',
    _fetch: async (_url, init) => {
      capturedHeaders = init.headers;
      return mkResponse({ status: 200, body: [] });
    }
  });

  // Without env: no Authorization header
  delete process.env.CL_TEST_TOKEN_ENV_VAR;
  await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });
  assert.equal(capturedHeaders.Authorization, undefined);

  // With env: Authorization header present
  process.env.CL_TEST_TOKEN_ENV_VAR = 'test-secret-token';
  try {
    await courtlistenerCitationLookupProviderAdapter.executeCase({
      benchmarkCase: BASE_CASE,
      // fresh config so the WeakMap-cached limiter doesn't carry over quota state
      config: { ...config }
    });
    assert.equal(capturedHeaders.Authorization, 'Token test-secret-token');
  } finally {
    delete process.env.CL_TEST_TOKEN_ENV_VAR;
  }
});

test('envelope finalOutputText is valid JSON matching the documented shape', async () => {
  const config = baseConfig({
    _fetch: async () =>
      mkResponse({
        status: 200,
        body: [
          {
            citation: '410 U.S. 113',
            normalized_citations: ['410 U.S. 113'],
            status: 200,
            clusters: [{ id: 42, case_name: 'X v. Y' }]
          }
        ]
      })
  });

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });

  const parsed = JSON.parse(result.finalOutputText);
  const requiredKeys = [
    'provider',
    'query',
    'raw_query',
    'status',
    'provider_ambiguous',
    'normalized_citations',
    'results',
    'result_count',
    'total_available'
  ];
  for (const key of requiredKeys) {
    assert.ok(key in parsed, `envelope missing key '${key}'`);
  }
  assert.equal(parsed.provider, 'courtlistener-citation-lookup');
  assert.equal(parsed.result_count, 1);
});

test('_internals.normalizeEnvelope handles missing cluster id gracefully', () => {
  const envelope = _internals.normalizeEnvelope('cite', [
    { status: 200, clusters: [{ case_name: 'No ID Case' }] }
  ]);
  assert.equal(envelope.results.length, 1);
  assert.equal(envelope.results[0].cluster_id, null);
  assert.equal(envelope.results[0].case_name, 'No ID Case');
});

test('authenticated tier skips docs bootstrap and uses empirical CL limits', async () => {
  let docsFetchCalled = false;
  process.env.CL_AUTH_TIER_TEST_TOKEN = 'test-token';
  try {
    const config = {
      endpoint: 'https://example.test/api/rest/v4/citation-lookup/',
      request_timeout_ms: 1000,
      token_env: 'CL_AUTH_TIER_TEST_TOKEN',
      _rateLimitsSilent: true,
      _rateLimitsFetchFn: async () => {
        docsFetchCalled = true;
        return { ok: true, status: 200, async text() { return '5 per minute, 50 per hour, 125 per day'; } };
      }
    };
    const limiter = await _internals.ensureRateLimiter(config);
    assert.equal(docsFetchCalled, false, 'docs bootstrap should not run when token is present');
    assert.equal(limiter.source, 'authenticated');
    // CL enforces 10/min and 100/hour for authenticated citation-lookup
    // (confirmed by 429 response bodies), not the 60/min the docs claim.
    assert.equal(limiter.limits.per_minute, 10);
    assert.equal(limiter.limits.per_hour, 100);
  } finally {
    delete process.env.CL_AUTH_TIER_TEST_TOKEN;
  }
});

test('pre-flight short-circuits when Retry-After exceeds max_honored_backoff_ms', async () => {
  // Simulate a case where a prior 429 set serverReset far in the future
  // (empirically CL's per-day cap emits a ~21-hour Retry-After). The adapter
  // should refuse to sleep through that and short-circuit as quota_exhausted.
  let now = 1_000_000_000_000;
  const config = baseConfig({
    _rateLimitsNow: () => now,
    _fetch: async () => {
      // Should never be reached — pre-flight short-circuits first.
      throw new Error('fetch should not be called');
    }
  });
  // Prime the limiter with a far-future serverReset via a fake 429 response.
  const limiter = await _internals.ensureRateLimiter(config);
  limiter.applyResponseHeaders({ 'retry-after': '80000' }); // 22 hours

  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'quota_exhausted');
  assert.match(result.error.message, /exceeding max_honored_backoff_ms/);
});

test('429 Retry-After above the cap fails-fast instead of sleeping', async () => {
  let calls = 0;
  const config = baseConfig({
    _fetch: async () => {
      calls += 1;
      return mkResponse({
        status: 429,
        body: '{"detail":"Rate limit exceeded"}',
        headers: [['retry-after', '80000']] // 22 hours — above the 1-hour cap
      });
    }
  });
  const result = await courtlistenerCitationLookupProviderAdapter.executeCase({
    benchmarkCase: BASE_CASE,
    config
  });
  // Single attempt, no rate-limit retry sleeps
  assert.equal(calls, 1);
  assert.equal(result.status, 'provider_failure');
  assert.equal(result.error.kind, 'rate_limited');
});

test('describeQuotaExhaustion names the actual triggered window', () => {
  const limiter = {
    limits: { per_minute: 10, per_hour: 100, per_day: 5000 },
    serverReset: Date.now() + 1200_000
  };
  const hourMsg = _internals.describeQuotaExhaustion(limiter, 'per_hour');
  assert.match(hourMsg, /per_hour sliding-window cap \(100\)/);
  const backoffMsg = _internals.describeQuotaExhaustion(limiter, 'server_backoff');
  assert.match(backoffMsg, /server-side backoff/);
  assert.match(backoffMsg, /~1200s/);
  assert.doesNotMatch(hourMsg, /daily/);
});

test('anonymous tier bootstraps from docs and honors the parsed limits', async () => {
  delete process.env.CL_AUTH_TIER_TEST_TOKEN;
  const config = {
    endpoint: 'https://example.test/api/rest/v4/citation-lookup/',
    token_env: 'CL_AUTH_TIER_TEST_TOKEN',
    _rateLimitsSilent: true,
    _rateLimitsFetchFn: async () => ({
      ok: true,
      status: 200,
      async text() {
        return '5 requests per minute; 50 per hour; 125 per day';
      }
    })
  };
  const limiter = await _internals.ensureRateLimiter(config);
  assert.equal(limiter.source, 'live');
  assert.equal(limiter.limits.per_minute, 5);
  assert.equal(limiter.limits.per_hour, 50);
  assert.equal(limiter.limits.per_day, 125);
});

test('anonymous tier falls back to published anonymous limits when docs fetch fails', async () => {
  delete process.env.CL_AUTH_TIER_TEST_TOKEN;
  const config = {
    endpoint: 'https://example.test/api/rest/v4/citation-lookup/',
    token_env: 'CL_AUTH_TIER_TEST_TOKEN',
    _rateLimitsSilent: true,
    _rateLimitsFetchFn: async () => ({ ok: false, status: 500, async text() { return ''; } })
  };
  const limiter = await _internals.ensureRateLimiter(config);
  assert.equal(limiter.source, 'fallback');
  assert.deepEqual(limiter.limits, _internals.DEFAULT_RATE_LIMITS_ANONYMOUS);
});

test('_internals.pickClusterCitations builds strings from {volume,reporter,page}', () => {
  const citations = _internals.pickClusterCitations({
    citations: [
      { volume: '410', reporter: 'U.S.', page: '113' },
      { volume: '93', reporter: 'S. Ct.', page: '705' },
      'raw citation string'
    ]
  });
  assert.deepEqual(citations, ['410 U.S. 113', '93 S. Ct. 705', 'raw citation string']);
});
