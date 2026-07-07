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

## Run

**Prerequisites:** none. `COURTLISTENER_API_TOKEN` in your environment is optional — with it you get CL's authenticated rate limits; without it you get the anonymous limits (5/min, 50/hr, 125/day for the search endpoint). Tests use fixture responses so no token is needed to run `pnpm test`.

**Command** (200 case-question rows against the shipped `case-questions-200` benchmark config):

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-legal-search/case-questions-200.json \
  --provider-config configs/providers/courtlistener-search.json \
  --scorer-config configs/scorers/trustfoundry-legal-search.json \
  --out runs/cl-search-case-questions-200 \
  --parallel 1 \
  --force
```

Use `--limit N --offset K` for smokes or subsets; `--parallel 1` is required against anonymous CL to stay under the 5/min limit. Point at `key-facts-200.json`, `laws-200.json`, or `regs-200.json` for the other three targets. Configuration knobs are in [`configs/providers/courtlistener-search.json`](../../configs/providers/courtlistener-search.json).

## Jurisdiction filtering

The adapter scopes each row's search to the target court's jurisdiction (state supreme + appellate for state rows, federal appellate + district + bankruptcy for federal rows). Scoping is driven by a court-id → jurisdiction mapping the adapter reads from `data/courtlistener/court-jurisdictions.json`.

**The mapping is checked in.** It was built from CourtListener's public bulk data — the exact source files are recorded in the JSON's `source` field (currently `courts-2026-06-30.csv.bz2` + `courthouses-2026-06-30.csv.bz2`). No setup required to run the adapter with filtering.

To refresh against newer CL dumps:

```bash
node scripts/build-cl-jurisdictions.mjs --refresh
```

The script downloads the current `courts-*.csv.bz2` and `courthouses-*.csv.bz2` from CL's public S3 bucket, decompresses them via `bunzip2` (standard on macOS + Linux; use WSL on Windows), joins them into the shape the adapter expects, and writes the JSON in place. Rebuild is deterministic against the same input dumps — reruns produce byte-identical output. Requires `bunzip2` on `PATH`. No CL API rate limits apply (pulls from S3, not the API).

Configure the filter mode via the provider config's `jurisdiction_filter` field. Defaults to state supreme + appellate (`state_appellate_supreme`); other modes documented in the adapter source. If the mapping file is deleted, the adapter falls back to unfiltered search so a partial checkout still works.
