# Adapter Contracts

Public contract surface for the `@trustfoundry-ai/benchmarks` harness.

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

## Runtime helpers (coming in Phase 3)

Phase 3 of the refactor introduces `defineProviderAdapter`,
`defineBenchmarkAdapter`, and `defineScorerAdapter` factory helpers exported
from [`index.mjs`](./index.mjs). Consumers will register adapters via these
helpers to pick up any future validation / defaulting the framework wants
to add without breaking their adapter code.

For Phase 0 the barrel is empty — the type declarations are the contract.
