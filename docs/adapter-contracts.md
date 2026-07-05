# Adapter contracts

> **Pre-1.0 notice.** The harness is under active development. Adapter
> contracts and artifact schemas may change between minor versions until
> v1.0. Additive changes stay backward-compatible; renames or removals
> trigger a schema-version bump (`v1` → `v2`) as documented under
> [Schema versioning rules](#schema-versioning-rules). Pin by tag
> (`@trustfoundry-ai/benchmarks-harness@vX.Y.Z`) and consult
> [`CHANGELOG.md`](../CHANGELOG.md) before bumping.

This document is the long-form counterpart to
[`../src/core/contracts/README.md`](../src/core/contracts/README.md). The
short README lists the three adapter kinds, the four artifact schemas, and
the versioning policy at a glance. This document expands each in enough
detail to implement a new adapter, or to build an alternate harness that
consumes the same public interface (for example, one that targets
`api.trustfoundry.ai`).

## Overview

`@trustfoundry-ai/benchmarks-harness` runs a benchmark as a triple:

- A **benchmark adapter** loads and normalizes cases from a dataset.
- A **provider adapter** executes each case against an external system.
- A **scorer adapter** aggregates the per-case results into a summary.

The runner (`executeRun` in [`../src/core/runner.mjs`](../src/core/runner.mjs))
wires them together via the shared registry, writes four versioned JSON
artifacts, and returns a manifest that carries three fingerprints so
downstream tooling can decide whether two runs are compatible for resume,
retry, or merge.

Adapters are plain ESM objects. There are no classes to subclass, no
lifecycle hooks beyond the ones documented below, and no non-JSON data
crosses the interface. TypeScript declarations for every field live at
[`../src/core/contracts/`](../src/core/contracts/).

## Provider adapters

### Shape

```ts
interface ProviderAdapter {
  readonly id: string;
  readonly version: string;
  describe(args: { config }): Promise<ProviderDescribeResult>;
  executeCase(args: { benchmarkCase, config }): Promise<CaseResult>;
}
```

Definition:
[`../src/core/contracts/provider-adapter.d.mts`](../src/core/contracts/provider-adapter.d.mts).

### `describe` contract

Called once at run start, before any case is executed. Returns a JSON-safe
descriptor recorded in the run manifest so a reader can reconstruct which
target the run hit (`target`, `settings`, environment variables consumed).
`describe` must be side-effect free — no network calls, no state mutation,
no dependency on a specific case.

### `executeCase` contract

Called once per case. Returns a `CaseResult` whose `status` is either
`'completed'` (result is scorable) or `'provider_failure'` (result should
be treated as a miss but recorded so it can be retried). Any thrown
exception is captured by the runner as a synthetic `'provider_failure'`
row; adapters can prefer returning `{ status: 'provider_failure', error }`
when they know the shape of the error.

Guarantees the framework provides:

- Exactly one call per case per run (retries land in a fresh output
  directory via `retryFailedRun`).
- The `config` object is the parsed provider config; identical across
  cases within one run.
- The `benchmarkCase` is already normalized by the benchmark adapter.

Guarantees the framework expects from the adapter:

- `timing.startedAt` / `timing.completedAt` / `timing.durationMs` are
  filled. Streaming-style adapters also fill `ttfbMs` and
  `streamDurationMs`. Consumers that stratify by latency assume these
  fields exist for `'completed'` rows.
- `tokenUsage`, if present, uses the field names in
  `ProviderTokenUsage` verbatim. New fields are additive; existing
  fields are not renamed.
- `artifacts[]` paths are relative and do not escape the run dir. The
  runner rejects `..` segments and absolute paths before writing.

### Error semantics

`error.kind` is a short string classifier the adapter picks (e.g.
`'rate_limited'`, `'timeout'`, `'auth_failure'`). Scorers may key on this
to break out failure modes in the summary. Keep the set small and stable
within a version.

### Rate limiting and retries

The harness ships helpers, not policy. Use `RateLimiter`
(`../src/core/rate-limit.mjs`) when your provider imposes per-minute or
per-day caps; it persists window state under `state_path` so successive
runs share quota. Retries within one case belong to the adapter — if your
provider returns 429 and a `Retry-After` header, wait and try again inside
`executeCase` before returning a failure. Retries across cases are a
runner concern: use `retryFailedRun` (`../src/core/retry-failed.mjs`) to
re-issue misses from a completed run into a fresh directory.

### Reference implementation

[`../src/adapters/providers/trustfoundry-public-search.mjs`](../src/adapters/providers/trustfoundry-public-search.mjs)
is a full reference: HTTP client with a rate limiter, retry policy on
network errors, token accounting, and structured `artifacts[]` output.

## Benchmark adapters

### Shape

```ts
interface BenchmarkAdapter {
  readonly id: string;
  readonly version: string;
  readonly promptVersion?: string;
  readonly materializationVersion?: string;
  loadCases(args: { config, repoRoot }): Promise<BenchmarkLoadResult>;
}
```

Definition:
[`../src/core/contracts/benchmark-adapter.d.mts`](../src/core/contracts/benchmark-adapter.d.mts).

### `loadCases` contract

Returns:

- `benchmark` — a `BenchmarkDescriptor` recorded in the manifest. Must
  include `id`, `version`, `sourceRoot`, and the digest inputs
  (`sourceFiles[].sha256`) so the runner can compute a stable identity
  fingerprint. Optional `sourceCommit`, `promptVersion`, and
  `materializationVersion` participate in the compatibility fingerprint.
- `inventory` — every row in the source dataset, whether it was selected
  or skipped, plus a rollup. `skipReasons` is a per-record string array
  so downstream reports can explain a shrunken dataset without needing
  the raw source.
- `cases` — the array of normalized `BenchmarkCase` records the runner
  will iterate over. Only selected cases appear here.

The benchmark adapter is the only component that reads the raw dataset.
Providers see `cases[i]` directly and never touch the underlying files.

### Case normalization

Every `BenchmarkCase` carries at minimum:

- `caseId` — unique within the run. Downstream artifacts key on this.
- `benchmarkId` — matches the adapter's `id`.
- `prompt` — the string handed to the provider verbatim, or the prompt
  template's rendered output.
- `expectedAnswer` / `allowedAnswers` — as flexible as the scorer needs.
  Scorers document the shape they expect.
- `metadata.datasetIndex`, `metadata.datasetName`, `metadata.expected`
  — enough context for a human to look up the row in the raw dataset.

Adapters must be deterministic: two calls with the same `config` and the
same underlying dataset return the same `cases[]` in the same order. If
you shuffle, seed the shuffle from the config.

### Reference implementation

[`../src/adapters/benchmarks/citation-lookup.mjs`](../src/adapters/benchmarks/citation-lookup.mjs)
loads JSONL from disk with declarative filtering, size caps, and
per-record skip reasons. It's the smallest fully-featured example.

## Scorer adapters

### Shape

```ts
interface ScorerAdapter {
  readonly id: string;
  readonly version: string;
  describe(): Promise<ScorerDescribeResult>;
  score(args: { manifest, cases, providerResults }): Promise<ScorerResult>;
  scoreStream?(args: { manifest, pairs, onCaseScored }): Promise<ScorerResult>;
}
```

Definition:
[`../src/core/contracts/scorer-adapter.d.mts`](../src/core/contracts/scorer-adapter.d.mts).

### `score` and `scoreStream`

`score` is the simple entry point: hand it the loaded cases and provider
results as arrays, get back a `ScorerResult`. `scoreStream` is preferred
when the run has many cases — the runner iterates a paired
`(benchmarkCase, providerResult)` stream so the caller never holds every
row in memory. Streaming scorers must still return the same `ScorerResult`
shape.

Both entry points return:

- `caseScores` — one `CaseScore` per provider result, including
  `'unscorable'` and `'provider_failure'` rows so downstream analysis
  keeps row alignment.
- `summary` — the scorer-defined summary. Common fields:
  `overallScore`, `supportedScore`, `headline{}` (metric bundle),
  `latency_ms{}` (percentiles), `execution{}` (runtime counters).
- `metadata` — scorer id/version plus scorer-specific parameters
  (`cutoffs`, `headline_cutoff`, `extractionVersion`, ...). Anything
  that participates in the compatibility fingerprint belongs here.

### Metric conventions

- `hit@K` (`hitAt1` / `hitAt5` / `hitAt10` / `hitAt25`) — boolean; the
  gold answer appears in the top-K ranked results. If a scorer supports
  configurable cutoffs, expose them as `SUPPORTED_CUTOFFS`.
- `reciprocalRank` — `1 / hitRank` if the item is retrieved, `0`
  otherwise. Average across cases for MRR.
- `latency_ms` — a percentile bundle (`p50`, `p90`, `p95`, `p99`, `max`)
  aggregated from `providerResult.timing.durationMs`. Include only if
  latency is meaningful for the benchmark.
- `scoreBand` — a coarse categorical (`'ideal'` / `'acceptable'` /
  `'usable'` / `'failure'`) that groups similar cases in bar charts.

New metric fields are additive within a schema version. Renames trigger a
schema-version bump.

### Reference implementations

- [`../src/adapters/scorers/search-recall.mjs`](../src/adapters/scorers/search-recall.mjs)
  — recall / hit@K / MRR for search-style benchmarks.
- [`../src/adapters/scorers/citation-lookup.mjs`](../src/adapters/scorers/citation-lookup.mjs)
  — extraction + citation-normalization + hit@K composite.

## Artifact schemas

Every run emits four JSON artifacts. Their JSON Schemas live at
[`../src/core/contracts/artifact-schemas.json`](../src/core/contracts/artifact-schemas.json).

### `trustfoundry.benchmarks.run.v1` — `manifest.json`

Written at run start and updated at run end. Records:

- **`runId`** — the run's identity string.
- **`harness`** — `{ name, commit, version, originUrl }`. `commit` is the
  git SHA of the harness at run time; `version` is the package version;
  `originUrl` is the canonical origin so a fresh checkout is scriptable.
- **`benchmark` / `provider` / `scorer`** — `{ id, version, configPath,
  configSha256, ... }`. `configSha256` locks the exact config bytes.
- **`fingerprints`** — three digests:
  - `compatibility` — inputs that must match for two runs to be considered
    the same experiment (used by `retryFailedRun` and `mergeRuns` to
    refuse mismatched inputs).
  - `resume` — a subset of `compatibility` that must match for a
    checkpointed run to resume in a fresh directory.
  - `manifest` — digest of the full manifest for change detection.

### `trustfoundry.benchmarks.raw-row.v1` — `provider-results.jsonl`

One row per case. Concatenation of `benchmarkCase` fields plus the
`CaseResult` fields returned by the provider. Row order matches
`cases[]` order from the benchmark adapter.

### `trustfoundry.benchmarks.result.v1` — `scores.json`

The full `ScorerResult`: per-case scores, task scores if any, summary,
and scorer metadata.

### `trustfoundry.benchmarks.result-manifest.v1` — bundle manifest

Written by `publishResultBundle` when a run is promoted into
`results/<benchmark>/<run>/`. Records the SHA-256 of every file in the
bundle so `pnpm verify:results` can prove no bytes changed.

### Schema versioning rules

- **Additive change** (new optional field, new stratification bucket):
  no schema-version bump. Update the schema doc + a `CHANGELOG.md`
  entry noting the field.
- **Breaking change** (rename, remove, or retype a field): bump the
  schema's version suffix (`v1` → `v2`) AND bump the package's minor
  version. Add a `CHANGELOG.md` entry that names both the old and new
  field. Ship a one-release deprecation window before removal.
- **Frozen bundles never re-scored.** Published bundles under
  `results/` are checksummed. Any dataset, prompt, or scorer change
  that would alter the bytes of a published bundle is a breaking
  change even if the schema is unchanged. Verify with `pnpm
  verify:results` after every touch of scoring or dataset code.

## Registry and factories

Adapters register with the shared `defaultRegistry`
([`../src/core/registry.mjs`](../src/core/registry.mjs)):

```js
import { defaultRegistry } from '@trustfoundry-ai/benchmarks-harness';
import { myProviderAdapter } from './my-provider.mjs';
defaultRegistry.register('providers', myProviderAdapter);
```

The runner looks up adapters by `id` from this registry. Overlays
(private consumers) can register additional adapters at import time by
importing their own registry module (see `src/adapters/registry.mjs` in a
consumer repo).

`defineProviderAdapter`, `defineBenchmarkAdapter`, and
`defineScorerAdapter` from
[`@trustfoundry-ai/benchmarks-harness/contracts`](../src/core/contracts/index.mjs)
are thin factories that assert required keys at construction time and
return the input unchanged. Use them at every adapter declaration site;
they cost nothing at runtime and catch typos before the first case
executes.

## Testing utilities

[`@trustfoundry-ai/benchmarks-harness/testing`](../src/testing/index.mjs)
exports fixture builders (`makeBenchmarkCase`, `makeProviderResult`,
`makeManifest`) that materialize contract-conforming objects for tests
without hand-writing every field. Adapter tests should exercise the
`describe` and `executeCase` / `loadCases` / `score` entry points against
these fixtures rather than against live services.

## Versioning + compatibility summary

| Change class | Schema bump | Package bump | CHANGELOG required |
|---|---|---|---|
| Add optional field | none | patch | yes |
| Deprecate field | none | minor | yes |
| Remove or rename field | major (v1 → v2) | minor | yes |
| Fix bug without contract touch | none | patch | recommended |
| New adapter or reference implementation | none | minor | yes |
| New helper in `core/` | none | minor | yes |

Deprecation window: at least one release cycle with a warning before
removal. Deletion of a deprecated field is itself a breaking change.

Consumers pin the harness by git tag (`github:trustfoundry-ai/benchmarks#vX.Y.Z`).
When the harness bumps, run the consumer's `harness-compat` CI job to catch
contract regressions before merging the bump.
