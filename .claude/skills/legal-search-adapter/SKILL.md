---
name: legal-search-adapter
description: >
  Add a new provider adapter to @trustfoundry-ai/benchmarks-harness for the
  trustfoundry-legal-search benchmark. Covers the adapter module, provider
  config, benchmark configs, tests, docs, and a one-row smoke against the
  vendor API. Use when the user asks to add a case-law retrieval provider
  (LLM API with web search, search engine, vector DB, legal-tech vendor)
  and wants a working adapter as a PR against the public harness. Do NOT
  use for citation-quality audits or comparison PDFs — those live in the
  private `legal-search-audit` skill (benchmarks-lab).
metadata:
  scope: benchmarks
---

# Adding a new legal-search provider adapter

Everything a fresh session needs to add a `<vendor>-legal-search` provider adapter to the `@trustfoundry-ai/benchmarks-harness` package and land it as a PR.

## When to use this skill

Trigger this skill when the user asks to add a new provider that returns case-law retrieval results for the `trustfoundry-legal-search` benchmark. Typical asks:

- "Add an adapter for `<vendor>`"
- "I want to benchmark `<search engine / LLM / legal-tech tool>` against the trustfoundry-legal-search suite"
- "Wire up `<vendor>`'s API so we can run it through our 200-row case-question benchmark"

This skill covers **authoring** only: adapter code, provider config, benchmark configs, tests, docs, one-row smoke. It does NOT cover:

- 200-row runs, hand-merged bundles, citation-quality audit, comparison README + PDF — those live in the private `legal-search-audit` skill (benchmarks-lab). They require internal APIs and are not part of the public harness.
- Non-legal benchmarks (LLM eval, legalbench, etc.). If a different benchmark's adapter is needed, don't use this skill.

## What "adapter" means here

A provider adapter is one file exporting `{ id, version, describe({ config }), executeCase({ benchmarkCase, config }) }`. `executeCase` takes ONE benchmark case row and returns a `ProviderResult` shaped exactly the way the `trustfoundry-legal-search` scorer expects. The runner iterates cases and calls the adapter one row at a time (concurrency controlled via CLI `--parallel`).

Contracts to preserve:

- `id` is the stable string used everywhere (`configs/providers/<id>-*.json`, benchmark configs, scoring, CI). Convention: `<vendor>-legal-search`.
- `version` is a semver string. Bump when the adapter's outward behavior changes (new required config field, changed request shape, etc.). Independent of the harness version.
- `describe(config)` returns a small object with `{ id, version, modelId, endpoint, ...}` — used in `manifest.json` for provenance.
- `executeCase({ benchmarkCase, config })` is where the work happens. Return either a completed `ProviderResult` or a `provider_failure`.

## Model these implementations

Two working sibling adapters ship in this repo. **Read them side-by-side before writing anything** — do not restart from scratch.

- **`src/adapters/providers/openai-legal-search.mjs`** — OpenAI Responses API + built-in `web_search` tool + `text.format` strict JSON schema (structured outputs). Cleanest reference because the schema guarantees envelope shape.
- **`src/adapters/providers/exa-legal-search.mjs`** — Exa Search API + URL-based citation extraction (`src/data/citation-extractor.mjs`) + optional per-court `includeDomains` scoping via `src/data/court-url-map.mjs`. Use as your template if the new vendor returns URLs + text (not structured legal metadata).

**Copy the closer sibling.** They are 90% the same file — copy the one whose transport is closer to your vendor's, then change only what the new API requires.

| Vendor type | Copy from | Rationale |
|---|---|---|
| LLM with structured outputs (JSON-schema-enforced response) | `openai-legal-search.mjs` | Envelope shape is guaranteed by the schema; no fallback text-extraction path. |
| LLM without structured outputs (free-form text response) | `anthropic-legal-search.mjs` (if present; else adapt OpenAI's fallback path) | Requires `extractJsonFromText` fallback path. |
| Search engine (URL + excerpts, no legal metadata) | `exa-legal-search.mjs` | Uses `citation-extractor.mjs` to derive citations from URLs + text. |
| Vector DB / RAG endpoint | `exa-legal-search.mjs` | Same URL+text extraction pattern; may need custom URL-parse if vendor returns opaque IDs. |

## Envelope contract the scorer expects

`finalOutputText` MUST be JSON of this exact shape. The OpenAI adapter's strict JSON schema is authoritative — if in doubt, cross-reference it.

```json
{
  "query": "<original prompt>",
  "total_available": N,
  "result_count": M,
  "results": [
    {
      "rank": 1,
      "title": "People ex rel. Schmittdiel v. Board of Auditors",
      "citation": "13 Mich. 233",
      "citations": ["13 Mich. 233", "1865 Mich. LEXIS 19"],
      "bluebook_citation": "13 Mich. 233",
      "url": "https://www.courtlistener.com/opinion/6751062/",
      "publisher": "CourtListener",
      "date": "1865",
      "excerpt": "...",
      "summary": "...",
      "relevance": "...",
      "result_type": "case"
    }
  ]
}
```

Every field is required. Absent data → empty string, not omission. The scorer looks for gold's `canonical_citation`, `alternates`, or `cl_cluster_id` in the returned `citation` / `citations` / `url`. Ordering and rank matter; MRR uses `1/rank`.

If your vendor doesn't produce structured legal citations (title, citation, court, date), extract them from URLs + excerpt text using `src/data/citation-extractor.mjs`'s `extractCitations({ url, text, gold })`. Exa is the reference for this pattern.

## Failure taxonomy (fixed — do not invent new ones)

Return `{ status: 'provider_failure', error: { kind, message, status } }` with exactly one of these kinds. All appear in `_internals` on the reference adapters.

| kind | when | retryable? |
|---|---|---|
| `fetch_error` | local network / DNS / connection refused | **yes** — client-side transient |
| `timeout` | `AbortSignal.timeout` fired (initial fetch OR mid-SSE) | no — vendor-latency signal |
| `stream_error` | vendor emitted an explicit error SSE event mid-stream | no |
| `http_error` | non-2xx response (record `status` in the error) | no |
| `parse_error` | vendor returned unparseable JSON / truncated body | no |
| `tool_error` | vendor's search/tool call returned a failure status | no |
| `incomplete_response` | vendor returned `status: 'incomplete'` (hit max-output-tokens etc.) | no |
| `missing_results` | JSON parsed but envelope has no usable results/citations | no |
| `config_error` | missing env var, missing `model` field, etc. | no — setup issue |
| `validation_error` | non-case row given to a case-only adapter | no |

**Retry policy** (in `isRetryableProviderFailure`): ONLY `fetch_error`. Everything else is honest signal about vendor reliability and must be preserved through to the scoring output.

Reason: this was decided deliberately after observing 45% "parse_error: timeout" in early runs. Retrying a 3-minute timeout just gives the same query another 3-minute window at the same ceiling; the report should reflect the vendor's actual behavior, not our retry buffer.

## SSE streaming — two footguns

Applies to any vendor that streams responses (OpenAI Responses, Anthropic Messages with streaming, some search APIs).

1. **Never let `AbortSignal.timeout` fire in the SSE reader and get caught as `parse_error`.** OpenAI's adapter has `isAbortError()` that catches `TimeoutError` / `AbortError` name and the canonical `/operation was aborted|timed out|timeout/i` message string, routing them to a dedicated `timeoutError` state. **Copy that helper.** Test coverage: two tests — one for timeout during initial fetch, one for timeout mid-stream body.

2. **Adapter modules are import-cached inside a running `node bin/benchmarks.mjs run` process.** Editing the adapter while a run is in flight has zero effect on rows already dispatched. Change the code freely — but the in-flight bundle reflects the old logic until the process restarts.

For synchronous / non-SSE APIs (Exa, most search engines), footgun #1 doesn't apply — the `AbortSignal.timeout` only fires on the single fetch, and the standard try/catch classifies it correctly.

## File-by-file checklist for a new adapter

Copy from the closest sibling and rename. Keep the registry list alphabetical.

- [ ] `src/adapters/providers/<vendor>-legal-search.mjs` — the adapter itself
- [ ] `src/core/registry.mjs` — add one `import` and one `defaultRegistry.register('providers', ...)` call
- [ ] `configs/providers/<vendor>-legal-search-<variant>.json` — model / endpoint / `api_key_env` / `request_timeout_ms` / `max_output_tokens` (LLMs) or `top_k` (search) / pricing block (`_pricing_note` free-form)
- [ ] `configs/benchmarks/<vendor>-legal-search/case-questions-smoke-1.json` — 1-row smoke config
- [ ] `configs/benchmarks/<vendor>-legal-search/case-questions-200.json` — full 200-row config (mirrors the shared `data/trustfoundry-legal-search` dataset ref byte-for-byte apart from provider ref)
- [ ] `test/<vendor>-legal-search-provider.test.mjs` — mirror the sibling's tests: `buildRequestBody`, `describe`, envelope normalization, timeout classification (both variants if SSE), 5xx honest-signal, scorer round-trip
- [ ] `docs/adapters/<vendor>-legal-search.md` — mirror the Exa doc structure (Why this adapter exists / Configuration / How it's scored / Failure modes / Run command)
- [ ] `CHANGELOG.md` — add an entry under `[Unreleased]` describing the new adapter surface
- [ ] `README.md` — extend the adapters list if it enumerates them

## Smoke workflow

Requires the vendor's API key env var (declared in your provider config's `api_key_env`) in `.env.local` at the repo root. **Never write the key to stdout or logs.**

**Bounded launch — validate first.** Never send more than one row until wiring is proven. Start with a 1-row smoke:

```bash
node bin/benchmarks.mjs run \
  --benchmark trustfoundry-legal-search \
  --benchmark-config configs/benchmarks/<vendor>-legal-search/case-questions-smoke-1.json \
  --provider <vendor>-legal-search \
  --provider-config configs/providers/<vendor>-legal-search-<variant>.json \
  --scorer trustfoundry-legal-search \
  --scorer-config configs/scorers/trustfoundry-legal-search.json \
  --out /tmp/<vendor>-smoke-$(date +%s) \
  --parallel 1
```

Then inspect `/tmp/<vendor>-smoke-*/scores.json` and `provider-results.jsonl` to confirm:

- Envelope parses (no `parse_error` failure)
- Envelope has non-empty `results[]`
- At least one result has a plausible URL + citation
- `manifest.json` records the vendor's model/endpoint correctly

Larger runs (20-row validation, full 200-row) happen private-side under the `legal-search-audit` skill — do NOT run them from this repo unless the user explicitly asks.

## Pitfalls learned in prior sessions

- **Don't extend `request_timeout_ms` past 180000 to work around vendor slowness.** The 180s ceiling is a deliberate signal. If a vendor times out at 3 min, that IS the number to report.
- **Don't retry timeouts, parse errors, or 5xx.** They are all vendor-reliability signals. Only `fetch_error` is truly transient (local network / DNS).
- **When the vendor's structured-outputs mode is available (OpenAI Responses `text.format`, or equivalent), use it.** It eliminates the entire `extractJsonFromText` fallback path in the adapter and materially cleans up invalid-result-type defects.
- **Don't fabricate an `is_non_primary_source` check based on URL substring alone.** Almost every case-law URL hosts primary content. The right test is "is this the opinion text or a summary/brief/commentary" — the audit uses a trusted-host allowlist + narrow secondary-content pattern list. But the audit itself lives in the private skill; the adapter here just returns raw URLs.
- **Vendor names ARE allowed** on adapter/config/test/doc surfaces (Anthropic, OpenAI, Exa, Parallel — all named in file paths and code). Internal TrustFoundry infrastructure names are NOT (see `docs/adapter-contracts.md`).

## You are NOT done until

- [ ] `pnpm test` green — new adapter's tests pass, existing tests unchanged
- [ ] `pnpm lint` green
- [ ] `pnpm typecheck` green
- [ ] `pnpm verify:results` green (no result bundles touched)
- [ ] 1-row smoke against the real vendor API returns a well-formed envelope (results[].url populated, results[].citation populated, no provider_failure)
- [ ] `docs/adapters/<vendor>-legal-search.md` exists and describes configuration + scoring
- [ ] `CHANGELOG.md` has an `[Unreleased]` entry
- [ ] `src/core/registry.mjs` list is alphabetical
- [ ] No API key echoed to stdout in your adapter or test output
- [ ] `git status` shows no changes to files outside your six-item checklist (no accidental config drift, no result-bundle edits)

## Files worth reading first

- `src/adapters/providers/openai-legal-search.mjs` — structured-outputs reference
- `src/adapters/providers/exa-legal-search.mjs` — URL + text extraction reference
- `test/exa-legal-search-provider.test.mjs` — test skeleton for search-engine-style adapters
- `docs/adapters/exa-legal-search.md` — doc template
- `docs/adapter-contracts.md` — the boundary contract this adapter must obey
- `src/data/citation-extractor.mjs` — reusable URL + text → citations helper
- `src/core/contracts/index.mjs` — envelope / ProviderResult / failure taxonomy type definitions

## Related skills

- **`legal-search-audit`** (private, benchmarks-lab) — run this AFTER your adapter is merged and you have a 200-row bundle. Produces the citation-quality audit + comparison README + PDF for private design-partner sharing.
