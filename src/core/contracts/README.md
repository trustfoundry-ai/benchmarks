# Adapter Contracts

Public contract surface for the `@trustfoundry-ai/benchmarks` harness.
See [`../../../docs/adapter-contracts.md`](../../../docs/adapter-contracts.md)
for the long-form guide with implementation notes and reference walkthroughs.

## The three adapter kinds

The harness is composed of three pluggable adapter kinds that are wired up
by the runner via the shared registry:

| Kind        | Responsibility                                        | Type declarations                             |
|-------------|-------------------------------------------------------|-----------------------------------------------|
| `benchmark` | Load a dataset into a normalized `benchmarkCase[]`    | [`benchmark-adapter.d.mts`](./benchmark-adapter.d.mts) |
| `provider`  | Execute one case against an external system           | [`provider-adapter.d.mts`](./provider-adapter.d.mts)   |
| `scorer`    | Aggregate per-case scores into a summary result       | [`scorer-adapter.d.mts`](./scorer-adapter.d.mts)       |

Each adapter is a plain ESM object exporting `{ id, version, describe, ... }`
plus the kind-specific method (`loadCases`, `executeCase`, `score` /
`scoreStream`).

## Artifact schemas

Every run emits four versioned JSON artifacts. Their JSON Schemas live at
[`artifact-schemas.json`](./artifact-schemas.json):

- `trustfoundry.benchmarks.run.v1` — the run manifest (`manifest.json`)
- `trustfoundry.benchmarks.raw-row.v1` — one row per case (`raw.jsonl`)
- `trustfoundry.benchmarks.result.v1` — scored result (`result.json`)
- `trustfoundry.benchmarks.result-manifest.v1` — publish bundle manifest

Consumers of the public harness (external users of
`@trustfoundry-ai/benchmarks`, and the private benchmarks-lab consumer) can
depend on these being additive within a major version; a breaking change to
any of them bumps the schema version and the package's minor version.

## Versioning

- **Additive change** (new optional field, new stratification bucket): no
  version bump. Update the schema doc + a `CHANGELOG.md` entry.
- **Breaking change** (rename a field, remove a field, change a field's
  type): bump the schema's version suffix (`v1` → `v2`) AND bump the
  package's minor version. Add a `CHANGELOG.md` entry that names the old
  and new field.

## Reference implementations

The harness ships reference implementations of common adapter concerns.
These are optional — adapters that don't need them ignore them. If you're
building your own harness against `api.trustfoundry.ai`, you can copy
these patterns or import them directly from `@trustfoundry-ai/benchmarks/core`
(barrel at [`../index.mjs`](../index.mjs)):

- **`RateLimiter`** ([`../rate-limit.mjs`](../rate-limit.mjs)) —
  persistent, per-provider request throttling backed by disk state. Use
  when your provider imposes per-minute / per-day request caps.
- **`retryFailedRun`** ([`../retry-failed.mjs`](../retry-failed.mjs)) —
  reissue misses from a completed run into a new run directory. Supports
  either a caller-supplied filter or the built-in `'failed'` / `'misses'`
  selection policies. Preserves manifest fingerprints so results can be
  merged with the source run.
- **`TokenUsageAggregator`** ([`../token-usage.mjs`](../token-usage.mjs)) —
  aggregate per-case token counts into per-run totals. Feed from
  `providerResult.tokenUsage`.
- **`writeCaseCheckpoint`** / **`loadCaseCheckpoints`** /
  **`writeCaseProgressCheckpoint`** / **`clearCheckpoints`**
  ([`../checkpoints.mjs`](../checkpoints.mjs)) — per-case atomic
  checkpointing so a crashed run can resume without reissuing
  already-completed cases. Checkpoints carry the manifest resume
  fingerprint so an accidental resume against a different run's
  directory is caught before any work is duplicated.
- **`mergeRuns`** ([`../merge.mjs`](../merge.mjs)) — merge N chunk runs
  into one canonical run directory, refusing to mix runs whose
  benchmark / provider / scorer configs disagree. Emits
  `merge-report.json` with the input runs and any conflicts.
- **`buildManifest`** / **`assertCompatibleManifest`** /
  **`computeFingerprints`** ([`../manifest.mjs`](../manifest.mjs)) — the
  run-manifest builder plus fingerprint helpers used by retry and merge
  to refuse operations across incompatible runs.

## Adapter factories

`defineProviderAdapter`, `defineBenchmarkAdapter`, and
`defineScorerAdapter` are the current entry points for wiring up an
adapter. They validate the plain-object shape at registration time and
give the framework a place to add cross-cutting behavior later without
breaking consumer code. See
[`docs/adapter-contracts.md § Registry and factories`](../../../docs/adapter-contracts.md)
for authored examples plus the versioning rules that govern additive vs.
breaking contract changes.
