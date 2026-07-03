# Changelog

All notable, publication-relevant changes to the benchmarks harness and datasets are recorded here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.

## [Unreleased]

### Added

- **Dataset**: `expected.cl_cluster_id` field on every case-law row in
  `data/trustfoundry-legal-search-5k/case_questions.jsonl` and
  `case_key_facts.jsonl`. Values were extracted from TrustFoundry's Spanner
  (`document.identifier` column, which stores `courtlistener_<cluster_id>`
  for every doc TF ingested from CourtListener's bulk data). 100% coverage
  on both files (10,000 rows total). Enables native-ID matching against CL
  search results — every CL result carries a top-level `cluster_id`, so
  citation-string normalization is no longer the only path for CL scoring.
- **`--offset N` flag** on `pnpm benchmark run` and a **`merge-runs`
  subcommand** to combine multiple chunked runs into one canonical run
  directory. Both are strictly additive; existing invocations are
  unaffected (offset defaults to 0).

### Changed

- **Scorer** (`search-recall`): matches native IDs first (`document_uuid`,
  then `cl_cluster_id`), falls back to citation matching. The hit@K math
  is unchanged — any match at rank K still counts — but the code path
  makes the priority explicit and immune to citation-normalization drift.
- **Raw-row schema** (`trustfoundry.benchmarks.raw-row.v1`): gains an
  optional `expected.cl_cluster_id` string field. This is an additive
  change; older bundles that lack the field verify unchanged (missing
  field → null → scorer skips the cluster-id path).

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
- TrustFoundry scores are unchanged by this enrichment: TF provider results
  match via `document_uuid` (which is unchanged) and do not populate a
  `cluster_id` on returned rows. The new `cl_cluster_id` field is
  consulted only when a result has one.
