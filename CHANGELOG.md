# Changelog

All notable, publication-relevant changes to the benchmarks harness and datasets are recorded here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.

## [Unreleased]

### Changed

- **Repository layout restructured to group by suite.** Every
  suite-specific artifact now lives under a `trustfoundry-<suite>/`
  path so `configs/`, `data/`, `src/adapters/`, `suites/`, and `test/`
  all read the same way:
  - `configs/benchmarks/trustfoundry-legal-search/<variant>.json` and
    `configs/benchmarks/trustfoundry-citation-lookup/<variant>.json`.
  - `configs/providers/trustfoundry-{legal-search,citation-lookup}.json`.
  - `configs/scorers/trustfoundry-{legal-search,citation-lookup}.json`.
  - `data/trustfoundry-legal-search/{case_questions,case_key_facts,laws,regs}.jsonl`
    (renamed from `data/trustfoundry-legal-search-5k/`) and
    `data/trustfoundry-citation-lookup/{cases,statutes,regulations,negatives}/dataset.jsonl`.
  - `suites/trustfoundry-{legal-search,citation-lookup}/README.md`.
  - `test/adapters/{benchmarks,providers,scorers}/*.test.mjs` mirrors
    the `src/` layout; framework tests stay flat at `test/` root.
  - `entrypoint.sh` `BENCHMARK_CONFIG` env var takes the subpath form
    (e.g. `trustfoundry-legal-search/case-questions-200`).
- **Adapter renames** (file + id):
  - Provider `trustfoundry-public-search` → `trustfoundry-legal-search`.
  - Scorer `search-recall` → `trustfoundry-legal-search`.
  - Scorer `citation-lookup` → `trustfoundry-citation-lookup`.
  - Benchmark `citation-lookup` → `trustfoundry-citation-lookup`.
- **Published result bundles regenerated** against the renamed
  adapters so every `manifest.json` and `result.json` under `results/`
  references the new adapter ids. Bundle SHAs, `checksums.txt`, and
  the surface metrics in `result.json` all reflect the fresh
  2026-07-05 runs against the same live public search API.
- **Result bundle path layout simplified.** Bundles now live at
  `results/<suite-id>/<yyyy-mm-dd>/<run-leaf>/` (previously
  `results/<suite-id>/<provider-id>/<yyyy-mm-dd>-<run-leaf>/`). The
  provider that produced the bundle is recorded inside the bundle's
  `manifest.json` (`manifest.provider.id`) instead of in the path.
  Verification is location-independent — `checksums.txt` and
  `manifest.artifacts.*.path` reference file names only, so relocating
  a bundle within `results/` doesn't affect `pnpm verify:results`.
- Dropped `configs/benchmarks/trustfoundry-legal-search/case-questions-20.json`
  — a 200-row config is fast enough for smoke and keeps the config
  set tighter.
- Dropped `configs/providers/trustfoundry-citation-lookup-local.json`
  — was an internal-only localhost variant that shouldn't have shipped
  publicly.

### Documentation

- New `docs/adapter-contracts.md` — long-form guide to the three
  adapter kinds, the four artifact schemas, and the versioning rules.
  Referenced from `src/core/contracts/README.md`.
- `README.md` gains a pre-1.0 status banner and a per-suite status
  table so readers can see at a glance which suites have published
  evaluation numbers (`trustfoundry-legal-search`) vs. which are in
  development (`trustfoundry-citation-lookup`). `docs/adapter-contracts.md` gains a
  matching pre-1.0 notice about contract stability.

### Governance

- `.github/CODEOWNERS` now routes `src/core/**`, `src/core/contracts/**`,
  `data/**`, `results/**`, `suites/**`, `docs/adapter-contracts.md`,
  and `.github/**` to the core maintainers so contract-affecting
  changes cannot merge without a maintainer review.
- New `.github/pull_request_template.md` — checklist covering local
  `pnpm test` / `pnpm verify:results`, schema-version bumps,
  `CHANGELOG.md` entries, and documentation updates.

## [0.7.1] - 2026-07-04

### Added

- Every run's `manifest.json` now records `harness.originUrl`
  (`https://github.com/trustfoundry-ai/benchmarks.git`) alongside
  `harness.commit` and `harness.version` so consumers can reconstruct
  the exact reproduction recipe from the manifest alone. Existing
  bundle checksums are unaffected; new runs pick up the field
  automatically.

### Documentation

- README documents the `manifest.harness` fields and the three
  fingerprints (compatibility / resume / manifest) so external
  consumers understand the reproducibility model.

## [0.7.0] - 2026-07-04

### Changed

- **Runner unified.** `executeRun` now materializes provider results in
  memory, writes per-case checkpoints under
  `<outDir>/checkpoints/cases/*.json`, supports `--resume` against a
  compatible source manifest, and emits `preflight.json`,
  `report.json`, `token-usage.json`, and `<parent>/latest.json`
  alongside `manifest.json` / `provider-results.jsonl` /
  `scores.json`. The pre-refactor streaming-to-disk model is retired
  along with the per-case artifact behaviour it duplicated. Artifact
  materialization (with path-traversal rejection) is preserved.
  `runOpenEvaluation` is exported as an alias of `executeRun` for
  callers migrating from the private runner.
- **Manifest schema** now emits three fingerprints
  (`compatibility` / `resume` / `manifest`) instead of one. Identity
  inputs additively include `benchmark.sourceCommit`,
  `benchmark.promptVersion`, `benchmark.materializationVersion`,
  `provider.subject`, `provider.model`, and
  `scorer.extractionVersion`. Field names (`configSha256`,
  `sourceFiles`) are unchanged so `publishResultBundle` /
  `verifyResultBundle` continue to write and verify bundles
  byte-for-byte. Old bundles' frozen `manifest.json` files still
  verify green under `pnpm verify:results`.
- **Retry unified.** `retryFailedRun` supersedes `retryFailed`
  (retained as an alias) and adds a `selection` mode (`'failed'` or
  `'misses'`) alongside the existing `filter` callback.
  `retry-misses` CLI subcommand added. Retries reuse the runner's
  per-case checkpoints so an interrupted retry can resume.
- **Checkpoints** moved from `src/core/checkpoint.mjs` (class-based
  `CheckpointStore`) to `src/core/checkpoints.mjs` (functional
  `writeCaseCheckpoint` / `loadCaseCheckpoints` /
  `writeCaseProgressCheckpoint` / `clearCheckpoints`). Checkpoints
  now carry the resume fingerprint from the manifest so a resume
  against a different run's directory is caught before any work is
  duplicated.
- **CLI**: `pnpm benchmark run` learns `--benchmark`, `--provider`,
  `--scorer`, `--resume`, `--shard-index`, `--shard-count`, and
  `--retries`. `score` learns `--scorer` / `--scorer-config` to
  rescore an existing run with a different scorer. New `retry-misses`
  and `report` subcommands. `merge` accepted as an alias for
  `merge-runs`.

### Added

- **`./core` and `./core/*` sub-path exports** on the harness package
  so consumers can import specific core modules by name (e.g.
  `import { runOpenEvaluation } from '@trustfoundry-ai/benchmarks-harness/core/runner'`).
- **`buildReport`** and **`executeProviderCaseWithRetry`** exported
  from the runner barrel for consumers that want to compose their
  own run loop.

## [0.6.0] - 2026-07-04

### Changed

- **Package renamed** from `@trustfoundry-ai/benchmarks` to
  `@trustfoundry-ai/benchmarks-harness`. The `-harness` suffix signals
  that this package ships the benchmark harness (runner, contracts,
  helpers) rather than just benchmark data. Downstream consumers can
  update their `package.json` in a single line change.
- **`package.json` gains an `exports` map** so consumers can import
  from sub-paths: `@trustfoundry-ai/benchmarks-harness/contracts`,
  `.../testing`, `.../adapters/registry`, `.../artifacts`, `.../cli`.
- **`src/index.mjs`** is the new default entry point and re-exports
  from `src/core/index.mjs`.
- **`src/core/registry.mjs`** now exports `defaultRegistry` (the
  pre-populated registry) and `createRegistry()` (a factory for
  producing a fresh empty registry). The existing `registry` export
  remains as an alias of `defaultRegistry` for backward compatibility.
  `getBenchmarkAdapter`, `getProviderAdapter`, `getScorerAdapter`, and
  `adapterInventory` are exported alongside the pre-existing
  `getAdapter(kind, id)` so downstream consumers can use whichever
  ergonomics they prefer.

### Added

- **Adapter factory helpers** (`src/core/contracts/index.mjs`):
  `defineProviderAdapter`, `defineBenchmarkAdapter`, and
  `defineScorerAdapter`. Thin factories that validate required keys
  (`id`, `version`) at construction time and return the adapter
  unchanged. Consumers can now write
  `defineProviderAdapter({ id, version, executeCase })` for early
  validation of adapter definitions.
- **Testing barrel** (`src/testing/index.mjs`): `makeFixtureCase`,
  `makeFixtureAdapter`, `createTestRegistry`, plus re-exports of
  `createRegistry` and `defaultRegistry`. Downstream test suites can
  build fixtures without reaching into internal core modules.
- **Core helpers ported to public** as reference implementations:
  - `src/core/scheduler.mjs` — `normalizeScheduler`, `applyShard`,
    `mapWithConcurrency`, `positiveInteger`, `nonNegativeInteger`.
  - `src/core/hash.mjs` — `stableJson`, `hashObject`, `hashFile`
    (plus a re-export of `sha256Text` from `fs.mjs`).
  - `src/core/config.mjs` — `loadConfig`, `normalizeProviderSlug`,
    `effectiveRunId`.
  - `src/core/git.mjs` — `gitRevision`.
- **`.github/workflows/release.yml`** — on a `v*.*.*` tag push, runs
  `pnpm test` + `pnpm verify:results` and publishes a GitHub release
  with auto-generated notes. No npm publish yet.

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

- **New suite: `trustfoundry-citation-lookup`.** Four public datasets under
  `data/citation-lookup-{cases,statutes,regulations,negatives}/` totaling
  4,618 rows. Measures rank-1 citation-lookup accuracy on clean, sloppy,
  and reporter-variation citation surfaces (positives) plus false-positive
  rate on held-out non-citation strings (negatives). New benchmark loader
  (`src/adapters/benchmarks/trustfoundry-citation-lookup.mjs`) and per-benchmark scorer
  (`src/adapters/scorers/trustfoundry-citation-lookup.mjs`) with citation-first matching
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
  field), defaulting to `trustfoundry-legal-search` when both are omitted. The cutoffs
  validator now consults the selected scorer's exported
  `SUPPORTED_CUTOFFS` / `SUPPORTED_HEADLINE_CUTOFF`, so scorers with
  different K values (e.g. `trustfoundry-citation-lookup` with headline `hit@1`) can
  register without a runner change. Existing configs and result bundles
  continue to work unchanged.
- **Artifacts**: `publishResultBundle` and `verifyResultBundle` also read
  the scorer id dynamically (from `manifest.scorer.id` and
  `result.run.scorer.id` respectively). Existing bundles without those
  fields fall back to `trustfoundry-legal-search` and continue to verify.
- **Scorer** (`trustfoundry-legal-search`): matches native IDs first (`document_uuid`,
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
  back to `trustfoundry-legal-search`.

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
  bundle as `"trustfoundry-legal-search"`; the runner and artifacts pipeline changes
  keep writing that value for legal-search runs. Only new suites with a
  different `scorer` field in their benchmark config will produce
  bundles with a different `scorer.id`.
