# `openai-legal-search` adapter

Wraps [OpenAI's Responses API](https://platform.openai.com/docs/api-reference/responses) with the built-in `web_search` tool enabled, instructs `gpt-5.5` to search the web and return a JSON envelope of ranked case-law citations, and hands those citations to the same scorer as the legal-specific adapters.

## Why this adapter exists

Same reason as [`anthropic-legal-search`](anthropic-legal-search.md): so external readers can reproduce the qualitative comparison between "legal-specific search engine" and "frontier LLM with a web-search tool" on the same 200-row benchmark. This is a demonstrator, not a competing product.

## Integration approach

- Every benchmark row's natural-language question is sent as a single Responses API request with `tools: [{type: "web_search"}]`, SSE streaming enabled, and `text.format` set to a strict JSON schema pinning the results-envelope shape.
- The scorer envelope is derived from the model's structured output; the `web_search` tool's calls are surfaced in `providerMetadata` for post-run auditing.
- The adapter also supports **MCP tool configuration** (Parallel, Exa, TrustFoundry, or any other MCP server) via `tools[].mcp` on the provider config. This is an extension capability — the code path is present and covered by unit tests, but no MCP variant has been exercised at full 200-row scale yet. The default configuration ships with the built-in `web_search` tool, which is the tested path.
- Failures are classified honestly: SSE stream timeouts, `response.failed` events, `incomplete_response` states, unparseable JSON, and empty result arrays each surface as distinct `provider_failure` kinds so the audit can distinguish "the model gave a bad answer" from "the vendor timed out on us."

## Known shortcomings — and why they're the point

Same qualitative failure modes as the Anthropic adapter, with an OpenAI-specific flavor:

1. **SSE stream timeouts dominate.** On our runs, ~36% of the 200-row set died as timeouts at the 180-second request ceiling. Timeouts are not retried by design; a 3+ minute vendor request is a latency signal, not a transient hiccup.
2. **Missing reference URLs.** The strict JSON schema pins `url` as required, and the model complies with the string requirement by returning `""` on ~24% of candidate rows. Citation might still be valid, but it can't be clicked through and verified.
3. **Off-allowlist hosts.** Even when the model returns a URL, ~20% of URLs point at aggregators outside a small trusted set (`case-law.vlex.com`, `casemine.com`, `openjurist.org`, etc.). Content might be primary, but it hasn't been vetted for freshness / accuracy the way well-known legal repositories have.
4. **Citation hallucinations.** Same shape as with Anthropic: a real citation paired with a fabricated case name, or a real case name paired with an invented citation. Structured output constrains shape, not truth.
5. **Cost tracks poorly with quality.** Full 200-row runs land around $92 at $5/$30 per M input/output tokens, driven by unbounded `web_search` tool usage. Per successfully-completed row, ~$0.72.

The MCP extension exists precisely because we suspected (and continue to explore) whether pointing the same LLM at a legal-specific MCP server might close the gap. So far, only the default `web_search` variant has been exercised at scale.

## Configuration

- [`configs/providers/openai-legal-search-gpt-5-5.json`](../../configs/providers/openai-legal-search-gpt-5-5.json) — default variant, uses OpenAI's built-in `web_search` tool.

Set `OPENAI_API_KEY` in your environment. Benchmark configs at [`configs/benchmarks/openai-legal-search/`](../../configs/benchmarks/openai-legal-search/).
