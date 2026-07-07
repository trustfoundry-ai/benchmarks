# `courtlistener-citation-lookup` adapter

Runs the [CourtListener v4 citation-lookup endpoint](https://www.courtlistener.com/help/api/rest/v4/#citation-lookup). Given a row's expected citation string, the endpoint returns the resolved opinion cluster. Used by the `trustfoundry-citation-lookup` benchmark to measure how a legal-specific citation resolver handles clean, sloppy, and reporter-variation citations.

## Integration approach

- Every benchmark row's query becomes the JSON `{"text": "<query>"}` payload to `POST /api/rest/v4/citation-lookup/`; the adapter takes `response[0]` (the first resolved cluster) and shapes it into the harness's scorer envelope.
- Same rate-limit discovery model as `courtlistener-search`: limits are read live from the docs page at startup, with static fallbacks used only if that fetch fails. The citation-lookup endpoint's published rate is separate from opinion-search.
- Same header-honoring backoff model on 429.

## What to expect

Citation-lookup is the "did the resolver find the case" question — narrower than recall over a natural-language question. On a clean citation string with a canonical reporter, CourtListener's resolver is near-perfect. Recall drops on sloppy citations (missing periods, non-canonical reporter variants) and on the held-out non-citation negative queries, which is exactly what the benchmark stratifies on.

## Configuration

See [`configs/providers/courtlistener-citation-lookup.json`](../../configs/providers/courtlistener-citation-lookup.json).
