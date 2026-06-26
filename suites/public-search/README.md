# Public Search Case-Question Recall

This suite evaluates whether a search API returns the expected case-law document or citation for a legal question. Each row contains a generated question, an expected TrustFoundry document UUID, accepted citation metadata, and jurisdiction metadata. The TrustFoundry provider calls:

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

The repository includes one public data file for this suite:

```text
data/public-search-case-questions-5k/case_questions.jsonl
```

That file contains 5,000 rows. The smoke config and full config both reference the same file. The smoke config stops after the first deterministic 200 rows by setting `limit: 200`; there is no separate 200-row dataset to keep in sync.

### Test Data Schema

Each line in `case_questions.jsonl` is one JSON object. The main fields are:

| Field | Description |
| --- | --- |
| `query_text` | The legal question sent to the search API after the suite's query normalization step. |
| `document_uuid` | TrustFoundry document UUID for the expected case. TrustFoundry runs can score against this because the public search API returns document UUIDs in results. |
| `expected.canonical_citation` | Primary citation for the expected case. |
| `expected.alternates` | Additional accepted citations for the expected case. |
| `geo_level_1_identifier` | Row-level state or `FED` jurisdiction value. The TrustFoundry provider sends this as the state filter when state filtering is enabled. |
| `model_type` | Expected model type for the row, currently `case_question`. Provider configs must still declare the model type explicitly. |
| `doc_type` / `document_type` | Source document category metadata. |
| `field` | Source field used to generate the query, currently `questions`. |
| `split` | Dataset split, currently `test` for public rows. |
| `source_dataset` / `source_index` | Provenance fields for tracing the row back to the source generation set. |

The scorer accepts either identifier path. The TrustFoundry adapter uses `document_uuid` for apples-to-apples scoring against TrustFoundry results, while adapters for other systems can omit UUIDs and return citation fields that match `expected.canonical_citation` or `expected.alternates`.

### Commands

Smoke run, first deterministic 200 rows:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/public-search-case-questions-200.json \
  --provider-config configs/providers/trustfoundry-public-search-case-question.json \
  --out runs/public-search-200 \
  --parallel 4 \
  --force
```

Full public 5k run:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/public-search-case-questions-5k.json \
  --provider-config configs/providers/trustfoundry-public-search-case-question.json \
  --out runs/public-search-5k \
  --parallel 4 \
  --force
```

The provider config requires `model_type: "case_question"` and sends the row-level state filter by default.

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

## Example Result

A 200-row production smoke run against TrustFoundry on June 26, 2026 produced:

| Metric | Value |
| --- | ---: |
| Rows | 200 |
| Provider failures | 0 |
| `hit@1` | 0.375 |
| `hit@5` | 0.485 |
| `hit@10` | 0.505 |
| `hit@25` | 0.505 |
| `MRR` | 0.4241 |
| Mean latency | 3462.085 ms |
| p50 latency | 2140.5 ms |
| p95 latency | 7560.5 ms |

The corresponding verified result bundle contains `raw.jsonl`, `result.json`, `manifest.json`, and `checksums.txt`.
