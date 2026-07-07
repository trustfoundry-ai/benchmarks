# `exa-legal-search` adapter

Wraps [Exa's `/search` endpoint](https://docs.exa.ai/reference/search) — a general-purpose semantic web-search API. Every benchmark row's natural-language question goes out as a `/search` query; results come back as `{url, title, highlights}` records with no structured legal metadata; the adapter feeds the returned URLs and highlight excerpts to a citation extractor that produces the same scorer envelope used by every other provider adapter in this suite.

## Why this adapter exists

Same demonstrator framing as [`anthropic-legal-search`](anthropic-legal-search.md) and [`openai-legal-search`](openai-legal-search.md): so external readers can reproduce the qualitative comparison between a general-purpose semantic web-search API restricted to legal aggregator hosts and legal-specific search engines on the same benchmark.

## Configuration modes

The adapter has two orthogonal knobs: `domain_scope` (which sites Exa may search) and `query_mode` (what string we send). The combinations map to three purposes:

| `domain_scope` + `query_mode` | Purpose | Shipped? |
|---|---|---|
| `aggregators_only` + `question` | **Headline** — the number we publish. Same aggregator host list for every row; no per-row scoping. | Yes — `exa-legal-search-aggregators-only.json` |
| `primary_only` + `question` | **Diagnostic** — restricts Exa to the issuing court's `.gov` site, derived from the row's `authority_identifier`. Isolates the ranker's contribution by removing coverage as a variable. Not a headline number. | No (opt-in via config edit) |
| `primary_plus_aggregators` + `question` | **Diagnostic** — the primary site plus the aggregator list. Bounds "what does per-row primary scoping add on top of aggregators?" | No |
| `unrestricted` + `question` | **Diagnostic** — no `includeDomains`; the full open web. Bounds "what does any legal-domain scoping cost/buy?" | No |
| any scope + `title` | **Sanity check** — query becomes `document_title` + `canonical_citation` (i.e. the answer key). Answers "if we hand Exa the case name and citation directly, does it surface the case?" Not a headline number. | No |

The `primary_*` diagnostics use a `court_id → host` map. The shipped [`src/data/court-url-map.template.csv`](../../src/data/court-url-map.template.csv) is a small starter set (SCOTUS + 13 federal circuits); users who want to run them at broader coverage can point `TF_COURT_URLS_CSV` at their own extended CSV.

`providerMetadata.queryMode` and `providerMetadata.domainScope` record which mode a run used so bundles can be filtered / grouped when read back.

## Aggregator list rationale

The `aggregators_only` mode sends this host list on every request:

- **`courtlistener.com`** — the largest free open aggregator of U.S. case law. Exa surfacing a CL URL for a case is exactly the outcome a user searching for that case would want; this benchmark measures whether Exa can *find* the case, not whether Exa's index is disjoint from any particular aggregator's.
- **`law.justia.com`, `supreme.justia.com`** — Justia's free case-law hosting.
- **`scholar.google.com`** — Google Scholar's legal-opinion vertical.
- **`openjurist.org`** — federal opinion mirror.
- **`caselaw.findlaw.com`** — FindLaw's case-law path only (avoids their broader legal-news content).

Deliberately excluded from the default list:

- **Paid aggregators** (`vlex.com`, `casemine.com`, `casetext.com`) — Exa shouldn't score against content our users can't otherwise access from the same URL without a subscription.
- **Cornell LII** (`law.cornell.edu`) — the case-law snapshot is stale enough to introduce coverage noise rather than signal.

## `type: 'auto'` semantics

The shipped config sends `type: "auto"`, which lets Exa route each query to either its keyword or neural ranker on a per-query basis (Exa's recommended default). `providerMetadata.searchType` records what we *sent*; Exa's chosen mode is only visible in Exa's own logs. If you want deterministic mode selection across queries, override with `"search_type": "neural"` or `"search_type": "keyword"` in the provider config.

## How Exa is scored

Exa's raw response is `{url, title, highlights, text?, snippet?}` — no structured citations. The scorer needs a citation. The adapter bridges the gap with a two-path evidence check:

- **Strong hit** — either (a) the returned URL parses cleanly against the CourtListener opinion pattern (`courtlistener.com/opinion/{cluster_id}/`) and the cluster_id matches the row's gold `cl_cluster_id`, **or** (b) the gold canonical citation appears in the excerpt/highlights with **caption context** (case-name markers like "v.", "plaintiff/defendant", or a docket-number pattern immediately before the citation). Strong hits are the only rows that populate the `citation` field on the result envelope, and they are the only rows that count toward `hitAt{k}`.
- **Loose hit** — the gold citation appears in the returned text but the context looks like a **reference** (`see also`, `citing`, `quoting`, etc.) rather than a caption. Loose hits are surfaced in `providerMetadata.extraction` for auditing (they're often "later opinion citing the target case, not the target case itself") but do NOT contribute to `hitAt{k}`.

Every result's `_evidence` block preserves the URL parser that fired, the raw context classification for each match, and the per-host / per-parser breakdown so the citation extractor can be iterated against real run data.

## Known shortcomings — and why they're the point

Semantic web search is not built for legal retrieval, and the failure modes on this benchmark are stable across every configuration axis (query phrasing, scope width, aggregator inclusion):

1. **Ranker prioritizes topic-adjacency over jurisdiction / era / caption.** The general semantic ranker rewards results that look thematically similar to the query. Legal retrieval demands the opposite: the *correct* case in the *right jurisdiction* at the *right era*, not any thematically similar case.
2. **Reference-only citations are the majority of textual matches.** Most rows where the gold citation appears in Exa's excerpt turn out to be later opinions citing the target case, not the target case itself. The scorer catches this by classifying context (see [How Exa is scored](#how-exa-is-scored)); loose hits don't count.
3. **Empty-citation candidates dominate.** Exa returns `{url, title, highlights}`, not structured legal metadata. Most returned URLs have no directly extractable citation from the excerpt.
4. **No result deduplication.** Multiple appeal PDFs of the same underlying dispute can occupy consecutive ranks.
5. **Landing pages instead of opinions.** For some courts, Exa returns the district's opinion-index landing page or an archive summary, not any specific opinion.

Latency and cost are not the constraints (Exa returns in ~1-2s at $5 per 1000 queries); quality is.

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
