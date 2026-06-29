# TrustFoundry Legal Search

This suite evaluates whether a search API returns the expected legal document or citation for a generated legal search prompt. Public datasets cover case questions, case key facts, law questions, and regulation questions. Each row contains a generated query, an expected TrustFoundry document UUID, accepted citation metadata, and jurisdiction metadata. The TrustFoundry provider calls:

```text
POST https://api.trustfoundry.ai/public/v1/search
```

## Setup

Create an API key in `dashboard.trustfoundry.ai`, then export it as `TF_API_KEY`:

```bash
export TF_API_KEY=your_key_here
```

Install dependencies from the repository root:

```bash
pnpm install
```

## Run

The repository includes these public data files:

```text
data/public-search-case-questions-5k/case_questions.jsonl
data/trustfoundry-legal-search-5k/case_key_facts.jsonl
data/trustfoundry-legal-search-5k/laws.jsonl
data/trustfoundry-legal-search-5k/regs.jsonl
```

Each file contains 5,000 rows. Smoke configs and full configs reference the same files; smoke configs stop after the first deterministic 200 rows by setting `limit: 200`, so there are no separate 200-row datasets to keep in sync.

The key-fact file is selected from the existing deterministic 10k source after excluding rows whose normalized query is empty. Law and regulation files are the first 5,000 rows from their deterministic 10k source files.

### Test Data Schema

Each line in `case_questions.jsonl` is one JSON object. The main fields are:

| Field | Description |
| --- | --- |
| `query_text` | The legal query sent to the search API after the suite's query normalization step. |
| `document_uuid` | TrustFoundry document UUID for the expected document. TrustFoundry runs can score against this because the public search API returns document UUIDs in results. |
| `expected.canonical_citation` | Primary citation for the expected document. |
| `expected.alternates` | Additional accepted citations for the expected document. |
| `geo_level_1_identifier` | Row-level state or `FED` jurisdiction value. The TrustFoundry provider sends this as the state filter when state filtering is enabled. |
| `model_type` | Expected model type for the row: `case_question`, `case_key_fact`, `law_question`, or `reg_question`. The generic TrustFoundry provider config uses this row-level value. |
| `doc_type` / `document_type` | Source document category metadata. |
| `field` | Source field used to generate the query, such as `questions` or `key_facts`. |
| `split` | Dataset split, currently `test` for public rows. |
| `source_dataset` / `source_index` | Provenance fields for tracing the row back to the source generation set. |

The scorer accepts either identifier path. The TrustFoundry adapter uses `document_uuid` for apples-to-apples scoring against TrustFoundry results, while adapters for other systems can omit UUIDs and return citation fields that match `expected.canonical_citation` or `expected.alternates`.

### Commands

Case-question smoke run, first deterministic 200 rows:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/public-search-case-questions-200.json \
  --provider-config configs/providers/trustfoundry-public-search-case-question.json \
  --out runs/public-search-200 \
  --parallel 4 \
  --force
```

Case-question full public 5k run:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/public-search-case-questions-5k.json \
  --provider-config configs/providers/trustfoundry-public-search-case-question.json \
  --out runs/public-search-5k \
  --parallel 4 \
  --force
```

Key-fact, law, or regulation smoke run:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-legal-search-laws-200.json \
  --provider-config configs/providers/trustfoundry-public-search.json \
  --out runs/legal-search-laws-200 \
  --parallel 4 \
  --force
```

Key-fact, law, or regulation full public 5k run:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-legal-search-laws-5k.json \
  --provider-config configs/providers/trustfoundry-public-search.json \
  --out runs/legal-search-laws-5k \
  --parallel 8 \
  --force
```

Use the matching config names for other targets: `trustfoundry-legal-search-key-facts-*` or `trustfoundry-legal-search-regs-*`. The case-question provider config pins `model_type: "case_question"`; the generic provider config omits `model_type` and sends each row's `model_type`.

The TrustFoundry public-search provider makes one retry for transient provider failures: fetch errors, streamed provider error events, missing result events, or HTTP 5xx responses. It does not retry validation errors or HTTP 4xx responses. If the retry succeeds, the row is scored from the successful response and latency includes the full elapsed time across both attempts; if it still fails, it is reported as a provider failure.

### Request limit and scorer cutoffs

Both knobs live in one place: [`configs/scorers/search-recall.json`](../../configs/scorers/search-recall.json).

| Field | Purpose |
| --- | --- |
| `api_request_limit` | Number of results requested per `/public/v1/search` call (forwarded as `limit` in the request body). |
| `cutoffs` | List of K values for `hits@K` reported in the scores file. |
| `headline_cutoff` | The featured `hits@K` shown in the run summary. |

**Public API cap.** `api_request_limit` must align with the caller-facing cap enforced by the public search API at <https://api.trustfoundry.ai>. The current cap is 25; raising `api_request_limit` past it causes every call to fail with HTTP 400.

**Startup validation.** The runner refuses to start unless:

1. `api_request_limit >= max(cutoffs plus headline_cutoff)`; otherwise `hits@K` for K > `api_request_limit` is meaningless because the API would never return enough results.
2. `cutoffs` and `headline_cutoff` match the values the search-recall scorer is actually computing. The published result-bundle schema currently pins `hits@K` to `K in {1, 5, 10, 25}`; if you need different K values, update `src/adapters/scorers/search-recall.mjs` and the artifact schema together.

Each validation error names both numbers and points back to <https://api.trustfoundry.ai>.

Individual provider configs can still pin an explicit `limit` if an adapter needs different semantics; the explicit value wins over the scorer-driven default.

Create a shareable result bundle from a run:

```bash
pnpm benchmark publish-result --run runs/public-search-200 --out results/public-search-200 --force
pnpm benchmark verify-result results/public-search-200
```

## Metrics

The scorer can match either an expected document UUID or an accepted citation. TrustFoundry public API runs match on document UUID because the API returns it; adapters for systems that do not use TrustFoundry UUIDs can return citation fields and score against canonical or alternate citations.

- `hit@1`: the expected document or citation is the first result.
- `hit@5`, `hit@10`, `hit@25`: the expected document or citation appears within the top `k` results.
- `MRR`: mean reciprocal rank. A hit at rank 1 contributes `1.0`, rank 2 contributes `0.5`, rank 10 contributes `0.1`, and a miss contributes `0`. Aggregate MRR values are truncated to four decimal places.
- `failure_rate`: share of rows where the provider request failed or could not be scored.
- `strict_overall`: metrics over all rows with valid expected documents, counting provider failures as misses.
- `overall`: metrics over successful scored rows with valid expected documents.
- `latency_ms`: request timing summary with min, mean, p50, p95, and max.

Each run writes raw provider outputs and row-level scores so aggregate metrics can be recomputed from the evidence.

Top-level `hit@k` and `MRR` are computed over successfully scored rows and report provider failures separately. Use `strict_overall` when provider failures should count as misses.

## Example Test Results

For example output, inspect the scored summary at [`result.json`](../../results/public-search-case-questions/trustfoundry-public-search/2026-06-28-production-default-c8-5k/result.json). The full checked-in bundle also includes the raw row evidence, manifest, and checksums.
