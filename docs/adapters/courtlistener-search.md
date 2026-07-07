# `courtlistener-search` adapter

Runs the benchmark against [CourtListener's v4 opinion-search API](https://www.courtlistener.com/help/api/rest/v4/). CourtListener is the Free Law Project's public legal-research platform; its search engine is purpose-built for U.S. case law and is a natural apples-to-apples comparison to a commercial legal-search offering.

## Integration approach

- Every benchmark row is sent as a single `GET /api/rest/v4/search/` request. The row's natural-language question becomes the `q` parameter; the row's jurisdiction identifier scopes the search to state supreme + appellate (or federal courts for federal rows), mirroring the shape the TrustFoundry adapter uses.
- Semantic search is enabled (`semantic=true`); page size and `top_k` are pinned to 25 to match the other legal-search adapters and the scorer's `k` values.
- Rate limits are read from CourtListener's public docs page at process start so the limiter always sees the current published cap. Fallback numbers ship in the config only for the case where that fetch fails.
- The provider adapter's `RateLimiter` honors CL's `Retry-After` / `X-RateLimit-Reset` headers up to `SERVER_BACKOFF_MAX_MS` (5 min); longer waits short-circuit with `quota_exhausted` so operators can `--resume` cleanly once the natural quota window resets.
- The adapter's outbound `User-Agent` uses a role alias (`benchmarks@trustfoundry.ai`) per CourtListener's [attribution norms](https://www.courtlistener.com/help/api/rest/#permitted-usage) for public API traffic.

## What to expect

CourtListener is a legal-specific search engine. Its recall and MRR numbers should sit in the same "legal-domain-competitive" band as TrustFoundry's, though the two rank differently on some rows — often for reasons of corpus coverage or reporter normalization. Latencies at the CL v4 API are typically a second or two, and quotas are meaningful (see the fallback numbers in the config); this adapter is fine for the 200-row benchmark but you'll want to plan around the day quota if you run a 5k.

## Configuration

See [`configs/providers/courtlistener-search.json`](../../configs/providers/courtlistener-search.json). Set `COURTLISTENER_API_TOKEN` in your environment to get authenticated rate limits. The token is only required if you're running against production CourtListener; the tests use fixture responses and do not require a token.
