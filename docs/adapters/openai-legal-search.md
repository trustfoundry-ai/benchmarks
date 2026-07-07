# `openai-legal-search` adapter

Wraps [OpenAI's Responses API](https://platform.openai.com/docs/api-reference/responses) with the built-in `web_search` tool enabled, instructs `gpt-5.5` to search the web and return a JSON envelope of ranked case-law citations, and hands those citations to the same scorer as the legal-specific adapters.

## Why this adapter exists

Same reason as [`anthropic-legal-search`](anthropic-legal-search.md): to make the "frontier LLM with a web-search tool" option directly runnable inside this harness so evaluators can produce their own numbers against the same rows and scorer. This is a reference implementation — TrustFoundry is not publishing head-to-head numbers against it.

## Integration approach

- Every benchmark row's natural-language question is sent as a single Responses API request with `tools: [{type: "web_search"}]`, SSE streaming enabled, and `text.format` set to a strict JSON schema pinning the results-envelope shape.
- The scorer envelope is derived from the model's structured output; the `web_search` tool's calls are surfaced in `providerMetadata` for post-run auditing.
- The adapter also supports **MCP tool configuration** (Parallel, Exa, TrustFoundry, or any other MCP server) via `tools[].mcp` on the provider config. This is an extension capability — the code path is present and covered by unit tests, but no MCP variant has been exercised at full 200-row scale yet. The default configuration ships with the built-in `web_search` tool, which is the tested path.
- Failures are classified honestly: SSE stream timeouts, `response.failed` events, `incomplete_response` states, unparseable JSON, and empty result arrays each surface as distinct `provider_failure` kinds so the audit can distinguish "the model gave a bad answer" from "the vendor timed out on us."

## Failure modes evaluators are likely to encounter

Same qualitative failure classes as the Anthropic adapter, surfaced as distinct `provider_failure` kinds rather than hidden behind retries:

1. **SSE stream timeouts.** Long-running vendor requests hit the configured request-timeout ceiling (default 180s) and surface as `timeout` failures. Timeouts are not retried — a multi-minute vendor request is treated as a latency signal, not a transient hiccup.
2. **Missing reference URLs.** The strict JSON schema pins `url` as required; the model can comply with the string requirement by returning `""`. When it does, the citation may still be valid but can't be clicked through and verified.
3. **Off-allowlist hosts.** URLs the model returns may point at aggregators outside a small trusted set. Content might be primary, but it hasn't been vetted for freshness / accuracy the way well-known legal repositories have.
4. **Citation hallucinations.** A real citation paired with a fabricated case name, or a real case name paired with an invented citation. Structured output constrains shape, not truth.
5. **Cost driven by unbounded `web_search` tool usage.** The current OpenAI Responses API doesn't give the caller a per-request budget on `web_search`. Full 200-row runs at gpt-5.5 land in the low-$100 range at $5/$30 per M input/output tokens; single-row smokes are on the order of $0.70. Plan smokes and full runs accordingly.

The MCP tool-config extension is provided so evaluators can point the same LLM at a legal-specific MCP server and see whether that shifts the failure modes. The default configuration ships with the built-in `web_search` tool, which is the tested path.

## Run

**Prerequisites:** `OPENAI_API_KEY` in your environment.

**Command** (200 case-question rows via gpt-5.5 + built-in `web_search` tool):

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-legal-search/case-questions-200.json \
  --provider-config configs/providers/openai-legal-search-gpt-5-5.json \
  --scorer-config configs/scorers/trustfoundry-legal-search.json \
  --out runs/openai-gpt5-5-case-questions-200 \
  --parallel 4 \
  --force
```

See "Failure modes evaluators are likely to encounter" above for the cost/latency envelope; expect to plan for low-$100 for a full 200-row run and ~$0.70 for a single-row smoke. Use `--limit N` to keep smokes small.

Provider config: [`configs/providers/openai-legal-search-gpt-5-5.json`](../../configs/providers/openai-legal-search-gpt-5-5.json).
