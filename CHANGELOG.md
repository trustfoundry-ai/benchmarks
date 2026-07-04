# Changelog

All notable, publication-relevant changes to the benchmarks harness and datasets are recorded here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.

## [Unreleased]

## [0.5.0] - 2026-07-04

### Added

- **Framework helpers** as reference implementations for anyone building
  a benchmark harness against `api.trustfoundry.ai`:
  - `FileBackedRateLimiter` / `createProviderRateLimiter` /
    `rateLimitedProviderResult` (`src/core/rate-limit.mjs`) — persistent
    per-provider request throttling backed by JSON state on disk.
  - `retryFailed` / `defaultRetryFilter` (`src/core/retry.mjs`) — reissue
    misses from a completed run into a new run directory, using the
    source run's provider + scorer configs and asserting manifest
    compatibility fingerprints match.
  - `summarizeTokenUsage` / `normalizeTokenUsage`
    (`src/core/token-usage.mjs`) — per-task token accounting summaries.
  - `CheckpointStore` (`src/core/checkpoint.mjs`) — per-case atomic
    checkpointing so a crashed run can resume without reissuing
    already-completed cases.
  - `buildManifest` / `computeFingerprints` / `assertCompatibleManifest`
    (`src/core/manifest.mjs`) — run manifest builder + fingerprint
    helpers used by retry and merge to refuse operations across
    incompatible runs.
- **Barrel export**: `src/core/index.mjs` re-exports the new modules
  alongside the pre-existing runner / registry / artifacts helpers so
  external consumers can import from a single entry point.
- **CLI**: `pnpm benchmark retry-failed --run DIR --out DIR [--parallel N]
  [--force]` reissues misses from a completed run.
- **CLI**: `merge-runs` learns `--prefer <policy>` for duplicate-caseId
  resolution (`explicit-run-order` default, `latest`, `first`,
  `completed`). Every merge now emits a `merge-report.json` file
  alongside the merged bundle with input runs, prefer policy, and any
  conflicts observed.
- **Manifests** additively carry `runKind`, `harness.version`, and a
  `fingerprints.compatibility` hash over benchmark / provider / scorer
  identity fields. Existing scoring, reporting, and bundle verification
  behavior is unchanged.

### Changed

- **Runner**: manifest construction extracted from `runner.mjs` into
  `src/core/manifest.mjs`. `runner.mjs::executeRun` now calls
  `buildManifest` from the new module. Output shape gains the additive
  fields above; existing consumers ignoring unknown fields see no
  behavioral change.
- **Runner**: `mergeRuns` extracted from `runner.mjs` into
  `src/core/merge.mjs`. `runner.mjs` still re-exports `mergeRuns` so
  `import { mergeRuns } from '.../core/runner.mjs'` keeps working.

## [0.4.0] - 2026-07-04

### Added

- **New suite: `citation-lookup`.** Four public datasets under
  `data/citation-lookup-{cases,statutes,regulations,negatives}/` totaling
  4,618 rows. Measures rank-1 citation-lookup accuracy on clean, sloppy,
  and reporter-variation citation surfaces (positives) plus false-positive
  rate on held-out non-citation strings (negatives). New benchmark loader
  (`src/adapters/benchmarks/citation-lookup.mjs`) and per-benchmark scorer
  (`src/adapters/scorers/citation-lookup.mjs`) with citation-first matching
  and a generic native-`cluster_id` fallback. Five benchmark configs plus
  a scorer config live under `configs/`. See
  [`suites/citation-lookup/README.md`](suites/citation-lookup/README.md).
- **Dataset**: `expected.cl_cluster_id` field on every case-law row in
  `data/trustfoundry-legal-search-5k/case_questions.jsonl` and
  `case_key_facts.jsonl`. 100% coverage on both files (10,000 rows total).
  Enables native-ID matching for adapters whose results carry a top-level
  `cluster_id`.
- **`--offset N` flag** on `pnpm benchmark run` and a **`merge-runs`
  subcommand** to combine multiple chunked runs into one canonical run
  directory. Both are strictly additive; existing invocations are
  unaffected (offset defaults to 0).

### Changed

- **Runner**: scorer selection is now dynamic. The scorer id is read from
  the benchmark config's `scorer` field (or the scorer config's `id`
  field), defaulting to `search-recall` when both are omitted. The cutoffs
  validator now consults the selected scorer's exported
  `SUPPORTED_CUTOFFS` / `SUPPORTED_HEADLINE_CUTOFF`, so scorers with
  different K values (e.g. `citation-lookup` with headline `hit@1`) can
  register without a runner change. Existing configs and result bundles
  continue to work unchanged.
- **Artifacts**: `publishResultBundle` and `verifyResultBundle` also read
  the scorer id dynamically (from `manifest.scorer.id` and
  `result.run.scorer.id` respectively). Existing bundles without those
  fields fall back to `search-recall` and continue to verify.
- **Scorer** (`search-recall`): matches native IDs first (`document_uuid`,
  then `cluster_id`), falls back to citation matching. The hit@K math
  is unchanged — any match at rank K still counts — but the code path
  makes the priority explicit and immune to citation-normalization drift.
- **Raw-row schema** (`trustfoundry.benchmarks.raw-row.v1`): additively
  gains optional `expected.cl_cluster_id`, `expected.kind`,
  `expected.negative_category`, and `metadata.{document_type, difficulty,
  kind, negative_category, geo_level_2}` fields so citation-lookup
  bundles preserve stratification-relevant metadata on the roundtrip.
  Older bundles that lack the fields verify unchanged (missing → null).
- **Result envelope** (`trustfoundry.benchmarks.result.v1`): additively
  records `run.scorer` so `verify-result` can pick the correct scorer
  when recomputing summaries. Existing bundles without `run.scorer` fall
  back to `search-recall`.

### Notes for auditors and downstream consumers

- The 4 checked-in TrustFoundry result bundles for `case-questions` and
  `case-key-facts` (200 + 5k of each) record the *pre-enrichment* data-file
  sha256 in their `manifest.verification_inputs.data_files`. The CI verify
  path (`pnpm verify:results`) still passes because it runs with
  `verifyInputs: false` (it verifies the internal raw→result consistency
  only). Running `pnpm benchmark verify-result <bundle>` directly *will*
  report a data-file sha mismatch until those bundles are regenerated
  against the enriched dataset. Laws/regs bundles are untouched (their
  data files were not modified).
- TrustFoundry scores on the legal-search suite are unchanged by the
  cluster_id enrichment: TF provider results match via `document_uuid`
  (unchanged) and do not populate a `cluster_id` on returned rows. The
  new `cl_cluster_id` field is consulted only when a result exposes one.
- The manifest `scorer.id` string was already recorded on every existing
  bundle as `"search-recall"`; the runner and artifacts pipeline changes
  keep writing that value for legal-search runs. Only new suites with a
  different `scorer` field in their benchmark config will produce
  bundles with a different `scorer.id`.
