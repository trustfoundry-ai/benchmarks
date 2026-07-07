# `anthropic-legal-search` adapter

Wraps [Anthropic's Messages API](https://docs.anthropic.com/en/api/messages) with the built-in `web_search_20250305` tool enabled, instructs Claude to search the web and return a JSON envelope of ranked case-law citations, and hands those citations to the same scorer as the legal-specific adapters.

## Why this adapter exists

Anyone evaluating legal-search options is likely to ask *"can I just use a frontier LLM with a web-search tool for this?"* This adapter is provided so that question can be answered directly, on real benchmark rows, with an Anthropic API key and no additional wiring.

The adapter is a **reference implementation** — it exists to make the LLM-plus-web-search option runnable inside the same harness, against the same rows and scorer as any other adapter registered in this repo. TrustFoundry is not publishing head-to-head numbers against it; the run outputs are for the evaluator to draw their own conclusions from.

## Integration approach

- Every benchmark row's natural-language question is sent as a single Anthropic Messages request with the `web_search_20250305` tool enabled and a strict system prompt that pins the JSON envelope shape (`{results: [{rank, title, bluebook_citation}]}`).
- Configurable per model: `claude-haiku`, `claude-sonnet`, `claude-opus` variants ship with their own `configs/providers/anthropic-legal-search-{haiku,opus,sonnet}.json` files. All three use the same prompt, JSON schema, and 25-result top-K so results are strictly comparable.
- The `web_search_max_uses` knob is pinned per-config. Adapter surfaces `provider_failure` with kind `max_uses_exceeded` when the model exceeds its budget, so the scorer counts those rows as retrieval misses rather than dropping them.

## Failure modes evaluators are likely to encounter

These are the failure classes the adapter is designed to surface honestly (as distinct `provider_failure` kinds where possible) rather than hide behind retries or silent drops. They are properties of "general LLM + general web search + a JSON schema" applied to legal retrieval, not Anthropic-specific:

1. **JSON structure is not always reliable.** Even with a strict schema and an explicit "return only valid JSON" instruction, models sometimes truncate mid-envelope, escape braces incorrectly, or wrap the JSON in prose. The harness records those as `provider_failure` kind `parse_error` and the scorer treats them as misses rather than dropping the row.
2. **Non-primary sources.** Even when the model retrieves a real case, the URL it links to may be a secondary aggregator (case-summary blog, law-firm digest, code annotation), not a court opinion or a trusted case-law repository.
3. **Citation hallucinations.** A real citation paired with a fabricated case name, or a real case name paired with an invented citation. Structured output constrains shape, not truth.
4. **Latency and cost scale with model tier.** Approximate 200-row budgets from prior runs: ~$8 (Haiku), ~$15 (Sonnet), ~$36 (Opus). Median request latency roughly ~15s (Haiku) up to ~80s (Opus). Use these to plan a smoke or a full run.

## Run

**Prerequisites:** `ANTHROPIC_API_KEY` in your environment (`.env.local` also works if you source it).

**Command** (200 case-question rows via Claude Haiku — cheapest of the three variants):

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-legal-search/case-questions-200.json \
  --provider-config configs/providers/anthropic-legal-search-haiku.json \
  --scorer-config configs/scorers/trustfoundry-legal-search.json \
  --out runs/anthropic-haiku-case-questions-200 \
  --parallel 4 \
  --force
```

Swap the provider config for `anthropic-legal-search-sonnet.json` or `anthropic-legal-search-opus.json` to run the same rows against Claude Sonnet or Opus. See "Failure modes evaluators are likely to encounter" above for approximate 200-row budgets and latency by tier. Use `--limit N --offset K` for smokes.

**Provider configs:**
- [`configs/providers/anthropic-legal-search-haiku.json`](../../configs/providers/anthropic-legal-search-haiku.json)
- [`configs/providers/anthropic-legal-search-sonnet.json`](../../configs/providers/anthropic-legal-search-sonnet.json)
- [`configs/providers/anthropic-legal-search-opus.json`](../../configs/providers/anthropic-legal-search-opus.json)
