# Adding a suite

A suite is a benchmark, a scorer, one or more datasets, and a manifest naming
the targets they combine into. Adding one is a data change plus two adapters —
no edits to the CLI, the container entrypoint, or the generated README tables
are required.

## 1. Name it

`trustfoundry-<capability>`. The prefix means TrustFoundry authored the
benchmark, not that it only measures TrustFoundry — any registered provider
adapter can run against it. Pick a capability specific enough to read as
distinct from its siblings at a glance.

## 2. Write the adapters

- `src/adapters/benchmarks/<suite>.mjs` — loads rows into benchmark cases. See
  [`../src/adapters/benchmarks/trustfoundry-legal-search.mjs`](../src/adapters/benchmarks/trustfoundry-legal-search.mjs)
  for declarative filtering, size caps, and per-record skip reasons.
- `src/adapters/scorers/<suite>.mjs` — produces the `summary` object a
  published bundle carries. See
  [`adapter-contracts.md`](adapter-contracts.md#scorer-adapters) for the
  adapter shape and metric conventions. If you want your suite's numbers to
  show up in the generated headline table (step 6), report hit-rate cutoffs
  under `summary.overall.hit_at` (e.g. `{"hit@1": 0.93, "hit@5": 0.97}`) —
  the table's columns are derived from whatever cutoffs your own bundles
  report, not a fixed list.

If your gold is not a citation, declare `publishedExpectedFields` on the
benchmark adapter as an allowlist of the `metadata.expected` keys that must
survive into a published row, and add a round-trip test. Without it,
re-scoring a published bundle rebuilds every row with no gold and every
metric silently reads 0. See
[`../results/README.md`](../results/README.md#suites-whose-gold-does-not-fit-the-default-raw-row-shape).

## 3. Declare the targets

`suites/<suite>/suite.json`:

```json
{
  "id": "trustfoundry-<capability>",
  "title": "…",
  "status": "experimental",
  "targets": {
    "<target>": {
      "benchmark": "configs/benchmarks/<suite>/<target>.json",
      "provider": "configs/providers/<suite>.json",
      "scorer": "configs/scorers/<suite>.json",
      "rows": 1234,
      "tier": "full",
      "headline": true
    }
  }
}
```

The manifest shape is documented in
[`../src/core/contracts/suite-manifest.schema.json`](../src/core/contracts/suite-manifest.schema.json).
A few things in it are easy to get wrong:

- **Don't author a `bundle` key.** The loader derives it from the target's
  own key (the directory leaf a published bundle lands under), and the
  manifest rejects an authored one as an unknown property.
- **`headline` is not a restatement of `tier`.** A suite may have more than
  one `headline: true` target — one per independent category is normal. A
  target can also run at `tier: "full"` with `headline: false`: an invariant
  or negative population, for instance, is publication-grade but reported
  separately from the headline by construction, not folded into it.
- **Every file under `configs/benchmarks/<suite>/` must be claimed by
  exactly one target.** A test walks that directory and fails if a config
  isn't referenced by any target's `benchmark` path (the only exception is a
  narrow allowlist for vendor-adapter examples that aren't suites at all).
  If you add a config, add the target that claims it in the same change.

`status` controls two independent things: whether the suite appears in the
generated README tables (`published` only — see step 6), and how strictly
its result bundles are checked (see step 5). `experimental` is the status to
start at — it lets a suite land in the repository and iterate before every
target carries a published bundle. Move it to `published` once every
declared target has one.

Before running anything, sanity-check the target resolves:

```bash
pnpm benchmark resolve-target <suite>/<target> --json
```

This is the same check the CLI's `--target` and the container's
`BENCHMARK_CONFIG` use internally, and unlike `pnpm benchmark targets` (which
only lists what a manifest declares), it verifies the target's benchmark,
provider, and scorer config paths actually exist on disk — a typo'd path
fails here with the real problem, not partway through a run.

## 4. Write the suite README

`suites/<suite>/README.md`. Follow
[`../suites/trustfoundry-case-name-lookup/README.md`](../suites/trustfoundry-case-name-lookup/README.md) —
it is the fullest template: the cost ratio the benchmark is built around, the
dataset design, a metric table, the reproduction commands, and an explicit
"what this benchmark cannot claim" section.

## 5. Publish

Publishing is a pull request separate from the one that adds the suite — see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md#publishing-numbers). Freeze every
config first: `manifest.json` digests the benchmark, provider, scorer, and
data files at run time, and editing one afterwards invalidates the bundle.

```bash
pnpm benchmark run --target <suite>/<target> --out runs/<suite>-<target>
pnpm benchmark publish-result \
  --run runs/<suite>-<target> \
  --out results/<suite>/<yyyy-mm-dd>/<target>
pnpm benchmark verify-result results/<suite>/<yyyy-mm-dd>/<target>
```

The bundle directory and the `results/<suite>/latest.json` pointer are both
keyed by the target id — see
[`../results/README.md`](../results/README.md) for the full path
convention. How strictly the pointer is checked depends on your suite's
`status`:

- **`published`**: the pointer's key set must equal the manifest's declared
  target ids exactly, in both directions. Every target needs an entry, and
  every entry must name a real, declared target — a test enforces this.
- **`experimental` or `deprecated`**: the pointer file may not exist at all
  yet, and that's fine — a suite in progress can carry zero published
  targets. If the pointer does exist, its keys must still be a subset of the
  declared target ids: a partially-published suite is fine, a pointer
  naming a target the manifest never declared is still rejected.

## 6. Regenerate the tables

```bash
node scripts/generate-readme-tables.mjs
pnpm test && pnpm verify:results
```

The suite-status and latest-benchmarks tables in `README.md` are generated
from the suite registry and each published suite's `latest.json`, so they
only pick up suites with `status: "published"` — an `experimental` suite
stays out of the generated tables (though its own `suites/<suite>/README.md`
is always there for anyone who follows the link) until you flip its status.
