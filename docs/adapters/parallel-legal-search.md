# `parallel-legal-search` adapter

Wraps [Parallel's `/v1/search` endpoint](https://docs.parallel.ai/api-reference/search/search) — a general-purpose web-search API with an LLM-guided `objective` field and a three-tier retrieval mode (`turbo` / `basic` / `advanced`). Every benchmark row's natural-language question goes out as a `search_queries` entry; results come back as `{url, title, publish_date, excerpts}` records with no structured legal metadata; the adapter feeds the returned URLs and excerpt text to the same [citation extractor](../../src/data/citation-extractor.mjs) used by [`exa-legal-search`](exa-legal-search.md) so the outputs land in the same scorer envelope.

## Why this adapter exists

Same reason as [`anthropic-legal-search`](anthropic-legal-search.md), [`openai-legal-search`](openai-legal-search.md), and [`exa-legal-search`](exa-legal-search.md): to make a general semantic web search runnable inside this harness so evaluators can produce their own numbers against the same rows and scorer. This is a reference implementation — TrustFoundry is not publishing head-to-head numbers against it.

## Configuration modes

The adapter has three orthogonal knobs: `domain_scope` (which sites Parallel may search, via `advanced_settings.source_policy.include_domains`), `query_mode` (what string we send as the `search_queries` entry), and `search_mode` (Parallel's `turbo` / `basic` / `advanced` retrieval tier). Each combination answers a different question, and only one is meant as an ordinary "how well does Parallel retrieve?" measurement — the others are diagnostics that deliberately narrow or hint the search:

| `domain_scope` + `query_mode` | What it measures | Shipped? |
|---|---|---|
| `aggregators_only` + `question` | **Ordinary measurement.** Same aggregator host list for every row; no per-row scoping. This is the mode to reach for if you want a straight "given a natural-language legal question, what does Parallel return from free legal aggregators?" number. | Yes — `parallel-legal-search-aggregators-only.json` |
| `primary_only` + `question` | **Diagnostic.** Restricts Parallel to the issuing court's `.gov` site, derived from the row's `authority_identifier`. Isolates the ranker's contribution by removing coverage as a variable. The row's answer already implies the court, so this is not an ordinary measurement — treat it as an ablation. | No (opt-in via config edit) |
| `primary_plus_aggregators` + `question` | **Diagnostic.** Primary site plus the aggregator list. Bounds "what does per-row primary scoping add on top of aggregators?" | No |
| `unrestricted` + `question` | **Diagnostic.** No `include_domains`; the full open web. Bounds "what does any legal-domain scoping cost or buy?" | No |
| any scope + `title` | **Sanity check.** Query becomes `document_title` + `canonical_citation` (i.e. the row's answer). Answers "if we hand Parallel the case name and citation directly, does it surface the case?" — a floor rather than a measurement. | No |

The `primary_*` diagnostics use a `court_id → host` map. The shipped [`src/data/court-url-map.template.csv`](../../src/data/court-url-map.template.csv) is a small starter set (SCOTUS + 13 federal circuits); users who want to run them at broader coverage can point `TF_COURT_URLS_CSV` at their own extended CSV.

`providerMetadata.queryMode`, `providerMetadata.domainScope`, and `providerMetadata.searchMode` record which mode a run used so bundles can be filtered / grouped when read back.

## Aggregator list

Same list as `exa-legal-search` — kept in sync deliberately so the two adapters are directly comparable in `aggregators_only` mode:

- **`courtlistener.com`** — the largest free open aggregator of U.S. case law.
- **`law.justia.com`, `supreme.justia.com`** — Justia's free case-law hosting.
- **`scholar.google.com`** — Google Scholar's legal-opinion vertical.
- **`openjurist.org`** — federal opinion mirror.
- **`caselaw.findlaw.com`** — FindLaw's case-law path only (avoids their broader legal-news content).

Deliberately excluded from the default list:

- **Paid aggregators** (`vlex.com`, `casemine.com`, `casetext.com`) — Parallel shouldn't score against content our users can't otherwise access from the same URL without a subscription.
- **Cornell LII** (`law.cornell.edu`) — the case-law snapshot is stale enough to introduce coverage noise rather than signal.

See [`exa-legal-search.md`](exa-legal-search.md#aggregator-list-rationale) for the full rationale.

## `mode` and `objective` semantics

The shipped config sends `mode: "advanced"`, Parallel's most thorough tier. `turbo` and `basic` are available for cost / latency ablations. `providerMetadata.searchMode` records what we sent.

The shipped config also sets `objective` to `"Retrieve U.S. case law opinions relevant to the search query."`. Parallel treats `objective` as a natural-language description of search intent that guides ranking — the closest analog is the legal-scoping system prompt used by `anthropic-legal-search` and `openai-legal-search`. Set `"objective": null` in the provider config to omit the field entirely for a "raw retrieval, no intent scaffolding" ablation more directly comparable to `exa-legal-search`.

## How Parallel is scored

Parallel's raw response is `{url, title, publish_date, excerpts}` — no structured citations. The scorer needs a citation. The adapter bridges the gap with the same two-path evidence check `exa-legal-search` uses:

- **Strong hit** — either (a) the returned URL parses cleanly against the CourtListener opinion pattern (`courtlistener.com/opinion/{cluster_id}/`) and the cluster_id matches the row's gold `cl_cluster_id`, **or** (b) the gold canonical citation appears in the joined excerpt text with **caption context** (case-name markers like "v.", "plaintiff/defendant", or a docket-number pattern immediately before the citation). Strong hits are the only rows that populate the `citation` field on the result envelope, and they are the only rows that count toward `hitAt{k}`.
- **Loose hit** — the gold citation appears in the returned text but the context looks like a **reference** (`see also`, `citing`, `quoting`, etc.) rather than a caption. Loose hits are surfaced in `providerMetadata.extraction` for auditing (they're often "later opinion citing the target case, not the target case itself") but do NOT contribute to `hitAt{k}`.

Every result's `_evidence` block preserves the URL parser that fired, the raw context classification for each match, and the per-host / per-parser breakdown so the citation extractor can be iterated against real run data.

Parallel returns `excerpts` as an array of markdown-formatted snippets per URL; the adapter joins them (title + excerpts, separated by blank lines) before running the citation extractor. The joined form is also surfaced as the envelope's `excerpt` field, with the individual snippets separated by ` … `.

## Failure modes evaluators are likely to encounter

The same behaviors listed in [`exa-legal-search`](exa-legal-search.md#failure-modes-evaluators-are-likely-to-encounter) apply here — general-purpose semantic web search wasn't built for legal retrieval:

1. **Ranker prioritizes topic-adjacency over jurisdiction / era / caption.** The general semantic ranker rewards results that look thematically similar to the query; legal retrieval demands the *correct* case in the *right jurisdiction* at the *right era*.
2. **Reference-only citations show up as textual matches.** When the gold citation appears in a returned excerpt it is often a later opinion citing the target case, not the target case itself. The scorer classifies context (see [How Parallel is scored](#how-parallel-is-scored)); loose hits don't count toward `hitAt{k}`.
3. **Empty-citation candidates are common.** Parallel returns `{url, title, excerpts}`, not structured legal metadata. Many returned URLs have no directly extractable citation from the excerpt.
4. **`warnings[]` and `usage[]` in Parallel's response** are preserved on `providerMetadata.warnings` / `providerMetadata.usage` so a run bundle records vendor-side signals (validation warnings, SKU metrics) without any special evaluator effort.

Pricing is not published on Parallel's Search API reference page as of 2026-07-07 (the shipped config's `_pricing_note`). Evaluators should contact Parallel for current pricing before running the full 200-row config.

## Run

**Prerequisites:** `PARALLEL_API_KEY` in your environment.

**Command** (200 case-question rows, aggregators-only mode — the shipped default):

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/parallel-legal-search-aggregators-only/case-questions-200.json \
  --provider-config configs/providers/parallel-legal-search-aggregators-only.json \
  --scorer-config configs/scorers/trustfoundry-legal-search.json \
  --out runs/parallel-aggregators-case-questions-200 \
  --parallel 4 \
  --force
```

Use `--limit 1` for a one-row smoke before committing to the full 200-row run.

Provider config: [`configs/providers/parallel-legal-search-aggregators-only.json`](../../configs/providers/parallel-legal-search-aggregators-only.json).
