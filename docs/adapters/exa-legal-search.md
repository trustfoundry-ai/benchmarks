# `exa-legal-search` adapter

Wraps [Exa's `/search` endpoint](https://docs.exa.ai/reference/search) — a general-purpose semantic web-search API. The adapter sends each benchmark row's natural-language question, restricts `includeDomains` to a small list of curated free legal aggregators, and hands the returned URLs (with any extractable citations) to the same scorer as the legal-specific adapters.

## Why this adapter exists

Same demonstrator framing as [`anthropic-legal-search`](anthropic-legal-search.md) and [`openai-legal-search`](openai-legal-search.md): so external readers can reproduce the qualitative comparison between "legal-specific search engine" and "general-purpose semantic web-search API restricted to legal aggregator hosts" on the same benchmark.

## Integration approach — aggregators-only by default

The shipped default config pins `domain_scope: "aggregators_only"`: every row sends the same aggregator host list (CourtListener, Justia, Google Scholar, OpenJurist, FindLaw case-law path) as `includeDomains`, no per-row court scoping. This has two properties worth calling out:

- **No coverage-map required.** The adapter has no dependency on a per-court URL sheet in the default mode. Users can run the 200-row bench immediately with just an `EXA_API_KEY`.
- **Portability floor.** Since the adapter is the same code path Exa is using — same query builder, same result parser, same scorer envelope — its numbers *are* the qualitative floor of "what a general semantic web search over free legal aggregators can do on this benchmark."

The adapter also supports three other modes (`primary_only`, `primary_plus_aggregators`, `unrestricted`) that use a `court_id → host` map to send per-row `includeDomains` scoped to the target court's `.gov` site. The shipped [`src/data/court-url-map.template.csv`](../../src/data/court-url-map.template.csv) is a small starter set (SCOTUS + 13 federal circuits); users who want to test per-row primary-court scoping can point `TF_COURT_URLS_CSV` at their own extended CSV. Empirically these modes score similarly to the aggregators-only default, so the shipped config uses the simpler path.

## Known shortcomings — and why they're the point

Semantic web search is not built for legal retrieval, and the failure modes on this benchmark are stable across every configuration axis (query phrasing, scope width, aggregator inclusion):

1. **Ranker prioritizes topic-adjacency over jurisdiction / era / caption.** The general semantic ranker rewards results that look thematically similar to the query. Legal retrieval demands the opposite: the *correct* case in the *right jurisdiction* at the *right era*, not any thematically similar case.
2. **Reference-citation hits inflate the surface numbers.** Under audit review, most rows that scored as "hits" against a strict citation-match scorer were later opinions citing the target case, not the target case itself. The Exa result URL pointed to a modern opinion whose text contained the gold citation; the extractor found it; the scorer credited a hit.
3. **Empty-citation candidates dominate.** Exa returns `{url, title, highlights}`, not structured legal metadata. ~99% of returned URLs have no directly extractable citation from the excerpt.
4. **No result deduplication.** Multiple appeal PDFs of the same underlying dispute can occupy consecutive ranks.
5. **Landing pages instead of opinions.** For some courts, Exa returns the district's opinion-index landing page or an archive summary, not any specific opinion.

The 200-row aggregators-only run lands at ~5.5% Recall@25 and MRR ~0.02, versus TrustFoundry's ~72% and ~0.47 on the same rows — a ~15-25× gap. Latency and cost are not the constraints (Exa returns in ~1-2s at $5 per 1000 queries); quality is.

## Run

**Prerequisites:** `EXA_API_KEY` in your environment.

**Command** (200 case-question rows, aggregators-only mode — the shipped default):

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-legal-search/case-questions-200.json \
  --provider-config configs/providers/exa-legal-search-aggregators-only.json \
  --scorer-config configs/scorers/trustfoundry-legal-search.json \
  --out runs/exa-aggregators-case-questions-200 \
  --parallel 4 \
  --force
```

Full 200-row runs land around **~$1** (Exa charges $5 per 1000 search queries + $1 per 1000 content pages) with median request latency **~2s**. Use `--limit N` for smokes.

Provider config: [`configs/providers/exa-legal-search-aggregators-only.json`](../../configs/providers/exa-legal-search-aggregators-only.json).
