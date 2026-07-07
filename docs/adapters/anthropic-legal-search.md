# `anthropic-legal-search` adapter

Wraps [Anthropic's Messages API](https://docs.anthropic.com/en/api/messages) with the built-in `web_search_20250305` tool enabled, instructs Claude to search the web and return a JSON envelope of ranked case-law citations, and hands those citations to the same scorer as the legal-specific adapters.

## Why this adapter exists

TrustFoundry publishes evaluation numbers about its own legal search product. A natural question is: *how does that compare to just asking a frontier LLM to search for the case?* This adapter is how we make that comparison reproducible.

The adapter is a **qualitative demonstrator**, not a competing product. We ship it so anyone with an Anthropic API key can rerun the same 200-row benchmark and see for themselves what happens when you ask Claude to do legal retrieval via general web search.

## Integration approach

- Every benchmark row's natural-language question is sent as a single Anthropic Messages request with the `web_search_20250305` tool enabled and a strict system prompt that pins the JSON envelope shape (`{results: [{rank, title, bluebook_citation}]}`).
- Configurable per model: `claude-haiku`, `claude-sonnet`, `claude-opus` variants ship with their own `configs/providers/anthropic-legal-search-{haiku,opus,sonnet}.json` files. All three use the same prompt, JSON schema, and 25-result top-K so results are strictly comparable.
- The `web_search_max_uses` knob is pinned per-config. Adapter surfaces `provider_failure` with kind `max_uses_exceeded` when the model exceeds its budget, so the scorer counts those rows as retrieval misses rather than dropping them.

## Known shortcomings — and why they're the point

Every adapter in this file is a place where the "general LLM does web search" approach visibly falls over. The failure modes are stable across models and prompts:

1. **JSON structure is not reliable.** Even with a strict schema and an explicit "return only valid JSON" instruction, models routinely truncate mid-envelope, escape braces incorrectly, or wrap the JSON in prose. Every model has some prompt-response rate at which it produces unparseable output; the harness records those as `provider_failure` kind `parse_error` and the scorer counts them as misses.
2. **Non-primary sources.** Even when the model retrieves a real case, the URL it links to is often a secondary aggregator (case-summary blog, law-firm digest, code annotation), not a court opinion or a trusted case-law repository. The private-side citation-quality audit surfaces hundreds of these per model per 200-row run.
3. **Citation hallucinations.** A real citation paired with a fabricated case name, or a real case name paired with an invented citation. Structured output constrains shape, not truth.
4. **Latency, cost, and reliability scale unfavorably with model tier.** Median request latency runs from ~15s (Haiku) to ~80s (Opus) on the 200-row set. Cost tracks the same way.

These aren't Anthropic-specific — they're properties of "general LLM + general web search + a JSON schema" applied to legal retrieval. That is precisely why we built this adapter: to demonstrate the gap qualitatively on the same benchmark that legal-specific search engines are evaluated on, so nobody has to take our word for how large the gap is.

## Configuration

Three shipped variants map to three model tiers:

- [`configs/providers/anthropic-legal-search-haiku.json`](../../configs/providers/anthropic-legal-search-haiku.json)
- [`configs/providers/anthropic-legal-search-sonnet.json`](../../configs/providers/anthropic-legal-search-sonnet.json)
- [`configs/providers/anthropic-legal-search-opus.json`](../../configs/providers/anthropic-legal-search-opus.json)

Set `ANTHROPIC_API_KEY` in your environment. Benchmark configs at [`configs/benchmarks/anthropic-legal-search/`](../../configs/benchmarks/anthropic-legal-search/).
