# Citation Lookup

This suite evaluates whether a citation-lookup API returns the correct primary-law document for a user-entered legal citation. Users type citations in a range of forms — bluebook-canonical, casing-variant, punctuation-off, or reporter-alias — and a good citation-lookup API should resolve all of them to the same underlying document. The suite ships four public datasets covering case law, statutes, regulations, and held-out non-citation negatives, and provides a per-row scorer that reports rank-based hit@K and MRR alongside a false-positive rate on negatives.

The TrustFoundry provider calls:

```text
POST https://api.trustfoundry.ai/public/v1/search
```

with each row's `model_type` set to `citation_search`.

## Setup

Create an API key from your TrustFoundry account dashboard and export it as `TF_API_KEY`:

```bash
export TF_API_KEY=your_key_here
```

Install dependencies from the repository root:

```bash
pnpm install
```

## Datasets

The suite has four datasets. Each row is a single-line JSON object; see [Row schema](#row-schema) below.

| Kind | Config | Rows | Description |
| --- | --- | --- | --- |
| `citation-lookup-cases` | [`citation-lookup-cases.json`](../../configs/benchmarks/trustfoundry-citation-lookup/cases.json) | 3,152 | Case-law citations. 688 clean bluebook canonicals + 2,064 sloppy per-canonical variants + 400 reporter-alias variation surfaces. Covers 400 unique reporters. |
| `citation-lookup-statutes` | [`citation-lookup-statutes.json`](../../configs/benchmarks/trustfoundry-citation-lookup/statutes.json) | 756 | State + federal statute citations across 68 jurisdictions/authorities. |
| `citation-lookup-regulations` | [`citation-lookup-regulations.json`](../../configs/benchmarks/trustfoundry-citation-lookup/regulations.json) | 660 | State administrative codes + C.F.R. across 58 authorities. |
| `citation-lookup-negatives` | [`citation-lookup-negatives.json`](../../configs/benchmarks/trustfoundry-citation-lookup/negatives.json) | 50 | Held-out non-citation strings across 11 categories (bare dates, incomplete references, decontextualized volume numbers, etc.). The correct behavior is to return zero results. |

A combined config, [`all.json`](../../configs/benchmarks/trustfoundry-citation-lookup/all.json), loads all four datasets at once (4,618 rows total).

**Difficulty tiers.** Positive rows carry an `expected.difficulty` label:

- `clean` — the bluebook canonical form as it would appear in a well-formatted brief.
- `sloppy` — common user-input perturbations applied per-axis to a clean canonical: case changes (`u.s.` vs `U.S.`), section-marker substitutions (`§` vs `sec.` vs `section`), whitespace mangling (`v.` vs `v .`), and character noise. Sloppy rows share their `expected.canonical_citation` with a clean sibling so per-axis effects can be measured.
- `variation` — alternate reporter surfaces enumerated from a reporters database (e.g. `F. Supp.` vs `F Supp` vs `F.Supp.`). Each surface is treated as a distinct row.

**Held-out discipline.** No row's normalized query text appears in any citation-parser training corpus we're aware of. Sloppy variants whose corresponding clean canonical would leak are excluded, so the sloppy set tests generalization rather than memorization.

## Providers

- **[`trustfoundry-citation-lookup`](../../configs/providers/trustfoundry-citation-lookup.json)** — provider config for all four datasets. Omits `model_type` so each row's `model_type: 'citation_search'` (set by the benchmark loader) flows through unchanged, and disables the state filter because citations are jurisdictionally unambiguous.

Additional adapters can be registered by dropping a module under `src/adapters/providers/` and referencing it in a provider config's `"provider"` field. Adapters that populate a top-level `cluster_id` on their result rows can be scored against `expected.cl_cluster_id` when the dataset supplies one (see [Metrics](#metrics)).

## Run

### Commands

Cases dataset, first 50 rows (smoke):

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-citation-lookup/cases.json \
  --provider-config configs/providers/trustfoundry-citation-lookup.json \
  --scorer-config configs/scorers/trustfoundry-citation-lookup.json \
  --out runs/citation-lookup-cases-smoke \
  --limit 50 --parallel 4 --force
```

Full 3,152-row cases run:

```bash
pnpm benchmark run \
  --benchmark-config configs/benchmarks/trustfoundry-citation-lookup/cases.json \
  --provider-config configs/providers/trustfoundry-citation-lookup.json \
  --scorer-config configs/scorers/trustfoundry-citation-lookup.json \
  --out runs/citation-lookup-cases \
  --parallel 8 --force
```

Statutes / regulations / negatives use the same command shape with the matching benchmark config. The combined `citation-lookup-all.json` config runs all four datasets end-to-end (4,618 rows) — stratifications automatically split by `datasetName`.

The runner reads the scorer id from the benchmark config (`"scorer": "trustfoundry-citation-lookup"`), so `--scorer-config` above is optional as long as the config path in the default location matches the scorer's cutoffs.

## Metrics

Positive rows (`expected.kind === 'positive'`) are scored by first-hit rank across the ranked result list. Matches are sought in order: first by normalized citation string (against `expected.canonical_citation` plus `expected.alternates`), then — for results that expose a top-level `cluster_id` — by native ID against `expected.cl_cluster_id`. Whichever matches first wins the rank.

Negative rows (`expected.kind === 'negative'`) are scored by response emptiness: an empty result set is correct, a non-empty response is a false positive.

The scorer emits:

- `hit@1` — headline metric. Fraction of positive rows where the correct answer was returned at rank 1. For a citation-lookup benchmark, landing on THE right document at rank 1 is the point.
- `hit@5`, `hit@10`, `hit@25` — recall at successive cutoffs.
- `MRR` — mean reciprocal rank over positive rows.
- `ambiguous_match_rate` = `hit@5 − hit@1`. Positives where the correct answer was findable in the top-5 but not at rank 1 — a provider-agnostic ambiguity signal.
- `fp_rate` — false-positive rate on negative rows (non-empty response = false positive). `null` when no negatives are present.
- `cluster_id_fallback_rate` — fraction of positive hits earned via `cluster_id` rather than by citation match. Denominator: positive scored rows with `expected.cl_cluster_id` set and `hitRank !== null`. `null` when no result rows carry a `cluster_id` (e.g. TrustFoundry runs). A high value signals that the provider's citation formatting diverges from the accepted set — most hits are recovered only by the native-ID fallback.
- `latency_ms` — request timing summary with `min`, `mean`, `p50`, `p95`, `max`, and `n`.

Stratified breakdowns are reported under `byDocumentType`, `byDifficulty`, `byAuthority`, `byDatasource`, `byGeo`, and `byNegativeCategory`. Each stratum reports the same `hit@K` / MRR / fp_rate metrics scoped to that group.

Quality-control counts (`n_valid_gold`, `n_empty_gold`, `n_failed`, etc.) live under `quality`.

## Row schema

Each line in a dataset JSONL file is one JSON object. The main fields are:

| Field | Description |
| --- | --- |
| `caseId` | Stable per-row id; used as the row key across runs and result bundles. |
| `query_text` | The exact citation string sent to the search API. This is what the scorer's rank is computed against. |
| `expected.canonical_citation` | Bluebook-canonical form of the target citation. Primary key for scoring positives. `null` for negatives. |
| `expected.alternates` | Additional accepted citations for the target document. Scored on equal footing with `canonical_citation`. |
| `expected.document_uuid` | TrustFoundry document UUID for the target document (positives with case-law source only). Not consulted by this scorer — kept for cross-referencing. |
| `expected.cl_cluster_id` | Opinion-cluster identifier for the target document (case-law rows only, ~87% coverage). Used as a native-ID fallback when a result row exposes a top-level `cluster_id`. |
| `expected.document_type` | `case_law` / `statute` / `regulation` / `null` (for negatives). |
| `expected.difficulty` | `clean` / `sloppy` / `variation` / `null` (for negatives). |
| `expected.authority_identifier` | Court / statutory-code / regulatory-code identifier the row belongs to. Used for `byAuthority` stratification. |
| `expected.datasource_id` | Provenance identifier for the source dataset the row was sampled from. |
| `expected.geo_level_1` | Country identifier (`us`). |
| `expected.geo_level_2` | State/territory identifier (`ak`, `ny`, ...) or empty string for federal. Normalized to uppercase; empty becomes `FED` in the case metadata. |
| `expected.kind` | `positive` for citation rows, `negative` for held-out non-citation strings. |
| `expected.negative_category` | One of 11 categories describing the shape of the non-citation string (e.g. `date_short`, `date_long`, `volume_only`). Only present on negatives. |
| `expected.source_row` | Provenance pointer back to the row's source generation input. |

## Request limit and scorer cutoffs

Both knobs live in one place: [`configs/scorers/trustfoundry-citation-lookup.json`](../../configs/scorers/trustfoundry-citation-lookup.json).

| Field | Purpose |
| --- | --- |
| `api_request_limit` | Number of results requested per search call (forwarded as `limit` in the request body). |
| `cutoffs` | List of K values for `hits@K` reported in the scores file. |
| `headline_cutoff` | The featured `hits@K` shown in the run summary. For this suite it's `1` (citation lookup is a rank-1 task). |

**Public API cap.** `api_request_limit` must align with the caller-facing cap enforced by the public search API at <https://api.trustfoundry.ai>. The current cap is 25; raising `api_request_limit` past it causes every call to fail with HTTP 400.

**Startup validation.** The runner refuses to start unless:

1. `api_request_limit >= max(cutoffs plus headline_cutoff)`; otherwise `hits@K` for K > `api_request_limit` is meaningless because the API would never return enough results.
2. `cutoffs` and `headline_cutoff` match the values the scorer implementation is actually computing. If you need different K values, update `src/adapters/scorers/trustfoundry-citation-lookup.mjs` and the artifact schema together.

Each validation error names both numbers and points back to <https://api.trustfoundry.ai>.

## Publishing bundles

Create a shareable result bundle from a run:

```bash
pnpm benchmark publish-result \
  --run runs/citation-lookup-cases \
  --out results/citation-lookup/trustfoundry-public-search/<yyyy-mm-dd>-production-cases \
  --force

pnpm benchmark verify-result \
  results/citation-lookup/trustfoundry-public-search/<yyyy-mm-dd>-production-cases
```

Result bundles carry the raw provider rows (`raw.jsonl`), the recomputable scored summary (`result.json`), a schema-versioned manifest, and per-file checksums. Verification recomputes the summary from raw rows and asserts byte-for-byte equality against `result.json` via canonical JSON.

## Result bundles

Published bundles for this suite will land under [`results/citation-lookup/`](../../results/) as canonical runs are produced. The bundle path convention is `results/citation-lookup/<provider-id>/<yyyy-mm-dd>-<environment>-<label>/`.

## Dataset schema history

Field additions and other dataset-shape changes are documented in the repo-root [CHANGELOG.md](../../CHANGELOG.md).
