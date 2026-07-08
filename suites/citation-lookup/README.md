# Citation Lookup

This suite measures how well citation-lookup APIs resolve a user-entered citation string to the correct underlying document. Each row carries a query string (either a bluebook-canonical citation or a user-typed variant) and the identifiers of the expected document. The suite is provider-agnostic — any adapter that returns ranked candidate documents can be scored on the same rows with the same match logic.

The point is to make one number comparable across providers: **did the correct document rank first for a citation the user typed exactly as it appears in the wild?**

## Provider options

| Adapter | What it is | Supported datasets |
|---|---|---|
| `trustfoundry-legal-search` (via [`configs/providers/trustfoundry-citation-lookup.json`](../../configs/providers/trustfoundry-citation-lookup.json)) | TrustFoundry public search API with `model_type=citation_search` and the geo state filter disabled | cases, statutes, regulations, negatives |
| `courtlistener-citation-lookup` | CourtListener v4 `/api/rest/v4/citation-lookup/` — a dedicated citation-parse endpoint distinct from CL's opinion search | cases, negatives |

CourtListener's citation-lookup endpoint only covers case law, so statutes and regulations are TrustFoundry-only.

## Datasets

Four JSONL datasets, one file per target. All four use the `citation-lookup` benchmark adapter and the `citation-lookup` scorer.

Each positive target ships as a **200-row subset** (`-200`, stratified by authority, ~50/50 bluebook/noisy) and a **full** dataset. The subsets are the fast comparison layer; the full datasets are the depth layer.

| Target | Rows | Data file | Configs |
|---|---|---|---|
| `case_law` — U.S. case citations | 2,720 (688 bluebook + 2,032 noisy) | [`data/citation-lookup-cases/dataset.jsonl`](../../data/citation-lookup-cases/dataset.jsonl) | [`cases-200`](../../configs/benchmarks/citation-lookup/cases-200.json) · [`cases-full`](../../configs/benchmarks/citation-lookup/cases-full.json) |
| `statute` — state + federal statute citations | 356 (89 bluebook + 267 noisy) | [`data/citation-lookup-statutes/dataset.jsonl`](../../data/citation-lookup-statutes/dataset.jsonl) | [`statutes-200`](../../configs/benchmarks/citation-lookup/statutes-200.json) · [`statutes-full`](../../configs/benchmarks/citation-lookup/statutes-full.json) |
| `regulation` — state + federal regulation citations | 340 (85 bluebook + 255 noisy) | [`data/citation-lookup-regulations/dataset.jsonl`](../../data/citation-lookup-regulations/dataset.jsonl) | [`regulations-200`](../../configs/benchmarks/citation-lookup/regulations-200.json) · [`regulations-full`](../../configs/benchmarks/citation-lookup/regulations-full.json) |
| Negatives — synthetic non-citations (phone numbers, dates, addresses, etc.) | 50 | [`data/citation-lookup-negatives/dataset.jsonl`](../../data/citation-lookup-negatives/dataset.jsonl) | [`negatives`](../../configs/benchmarks/citation-lookup/negatives.json) |

The 200-row subsets are deterministic — build them locally with `node scripts/build-citation-lookup-subsets.mjs`. Each `-200` directory ships a `build-manifest.json` capturing the source SHA-256, per-tier row counts, and the mulberry32 seeds so any two builds produce byte-identical output.

### Difficulty tiers

Each positive row is tagged with one of two tiers:

- **`bluebook`** — the citation string is Bluebook-canonical (as it would appear in a well-edited brief).
- **`noisy`** — a common user-input perturbation is applied to the Bluebook citation: casing changes, section-marker substitution or removal, whitespace mangling, dropped periods, OCR-style character noise, and similar. One perturbation per row. This is the mode users type in the wild.

Negatives are unlabeled — they carry a `negative_category` (`phone`, `date_iso`, `address`, `digits_only`, `single_word_non_reporter`, …) so the false-positive rate can be stratified.

The dataset uses held-out inputs that do not appear in any citation-parser training corpus we're aware of.

## Row schema

Positive rows:

```json
{
  "caseId": "citation-lookup-cases-fed-akb-0001-bluebook",
  "query_text": "2016 Bankr. LEXIS 3710",
  "expected": {
    "kind": "positive",
    "document_type": "case_law",
    "canonical_citation": "2016 Bankr. LEXIS 3710",
    "alternates": [],
    "datasource_id": "courtlistener",
    "authority_identifier": "akb",
    "geo_level_1": "us",
    "geo_level_2": "",
    "difficulty": "bluebook",
    "sloppy_transform": null,
    "document_uuid": "0e1387f8-ae3e-a5bf-b875-e26fa2418fea",
    "cl_cluster_id": "8527474"
  }
}
```

Negative rows:

```json
{
  "caseId": "citation-lookup-negatives-0001",
  "query_text": "Feb. 13, 1999",
  "expected": {
    "kind": "negative",
    "document_type": null,
    "canonical_citation": null,
    "alternates": [],
    "negative_category": "date_short",
    "source_row": "synthetic-negatives_date_short:1"
  }
}
```

Field enums:
- `expected.kind`: `positive` | `negative`
- `expected.document_type` (positives): `case_law` | `statute` | `regulation`
- `expected.difficulty` (positives): `bluebook` | `noisy`
- `expected.cl_cluster_id` (positives, case_law only): the CourtListener opinion cluster id, when TrustFoundry's copy of the document was ingested from CourtListener. `null` for statutes and regulations.
- `expected.document_uuid` (positives, case_law only): TrustFoundry's stable document identifier for the same rows.

## Metrics

Headline: **Recall@1** (fraction of positives where the correct document ranks first). This is what the `overallScore` in the result bundle reports.

Supporting:
- Recall@1 and Recall@5 (also as `hitAt1`, `hitAt5`). Citation-lookup match keys are identity-based (document_uuid / cluster_id / normalized citation string), so outcomes are effectively binary at rank 1 for most rows; `hit@5` catches the small residual where the expected doc lands at rank 2–5 due to citation-string ambiguity.
- MRR (mean reciprocal rank) across positives.
- Latency p50 / p95 / mean / max (per-case wall-clock).
- False-positive rate on negatives (`negatives_overall.fp_rate`) — fraction of negatives for which the provider returned any results.
- Ambiguous-response rate on positives (`ambiguousRate`) — fraction of positives where the provider signaled ambiguity (CourtListener status 300, or any provider that populates `provider_ambiguous: true` in the envelope).

Stratifications: `byDocumentType`, `byDifficulty`, `byState`, `byDatasource`, `byNegativeCategory` — each carries the same `hit_at` / `mrr` / `n` triple (positives) or `fp_rate` / `correct_empty` / `n` (negatives).

## Match logic (positives)

A candidate matches the expected document if, in this order of preference:
1. `result.document_uuid` equals `expected.document_uuid`, or
2. `result.cluster_id` equals `expected.cl_cluster_id`, or
3. `normalizeCitation(result.citation)` is in the set built from `expected.canonical_citation` and `expected.alternates`.

The first-ranked candidate satisfying any of these wins. Order-of-preference is documentation-only — the score doesn't depend on it because we take the first ranked candidate that matches by any signal.

## Match logic (negatives)

A negative row is correct iff the provider returns zero results. Any non-empty response counts as a false positive.

## Run commands

Assumes `TF_API_KEY` (TrustFoundry) and `COURTLISTENER_API_TOKEN` (CourtListener) are set. Every command runs from the repo root.

TrustFoundry — cases (full):

```
pnpm benchmark run \
  --benchmark-config configs/benchmarks/citation-lookup/cases-200.json \
  --provider-config configs/providers/trustfoundry-citation-lookup.json \
  --scorer-config configs/scorers/citation-lookup.json \
  --out runs/citation-lookup-cases-tf \
  --parallel 4
```

TrustFoundry — statutes / regulations / negatives: identical shape, swap `cases.json` for `statutes.json` / `regulations.json` / `negatives.json`.

CourtListener — cases:

```
pnpm benchmark run \
  --benchmark-config configs/benchmarks/citation-lookup/cases-200.json \
  --provider-config configs/providers/courtlistener-citation-lookup.json \
  --scorer-config configs/scorers/citation-lookup.json \
  --out runs/citation-lookup-cases-cl \
  --parallel 2
```

CourtListener enforces 60 citations / minute at the endpoint; the adapter respects a client-side sliding-window rate limit. Full-scale runs on the cases dataset take about an hour.

## Reproducibility

Dataset rows are deterministic given the source seeds recorded in each `data/citation-lookup-*/build-manifest.json`. The manifest also records source CSV SHA-256s, the priority-axes list used for the noisy variants, and the exclusion-set size. Two builds from the same seeds produce byte-identical JSONL.

The cases dataset carries an `enrichment-report.json` documenting the cluster-id / document-uuid resolution coverage over its rows. The current build resolves 100% of positive case rows.
