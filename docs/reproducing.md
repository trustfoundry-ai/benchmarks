# Reproducing a published number

Every bundle under `results/` records the harness commit, the config bytes, and
the dataset digests that produced it. This is how to rerun one.

## 1. Check out the harness commit the bundle names

```bash
COMMIT=$(jq -r '.run.harness.commit' results/<suite>/<date>/<target>/result.json)
git clone https://github.com/trustfoundry-ai/benchmarks.git
cd benchmarks && git checkout "$COMMIT"
```

Every published bundle's harness commit is checked to be an ancestor of `main`
(`pnpm check:provenance` — see [Publishing numbers](../CONTRIBUTING.md#publishing-numbers)),
so this checkout always resolves to a commit a plain clone can reach.

## 2. Install and configure

```bash
pnpm install
export TF_API_KEY=...   # from your TrustFoundry account dashboard
```

## 3. Run the same target

A bundle's `result.json` records the exact config paths it ran under, at
`run.benchmark.configPath`, `run.provider.configPath`, and
`run.scorer.configPath`. Pass them straight to `pnpm benchmark run`:

```bash
pnpm benchmark run \
  --benchmark-config <run.benchmark.configPath> \
  --provider-config <run.provider.configPath> \
  --scorer-config <run.scorer.configPath> \
  --out runs/<label> --parallel 4 --retries 2
```

## 4. Compare

Before trusting a comparison, confirm the inputs actually match: `benchmark`,
`provider`, and `scorer` each carry a `configSha256` in your own run's
`manifest.json` and in the bundle's `result.json` under `run`. If any of the
three differ, the two runs used different config bytes, dataset
materialization, or scorer version, and are not comparable no matter how close
the scores look.

With that confirmed, compare your `runs/<label>/scores.json` summary against
the bundle's `result.json` summary. `summary.overall.hit_at['hit@1']` and
`summary.overallScore` (the headline score) are the numbers to check first.

## Two things to assert on your own run

Both fail quietly, and both make a run look better than it is.

- **`providerFailures` must be 0**, and `total` must match the target's stated
  size. Failures are excluded from the denominator, not counted as misses, so
  a run that lost rows to timeouts still reports a hit rate.
- **Per-category denominators must be equal** where a suite claims equal
  allocation. That property is what makes the macro average and the pooled rate
  the same number; if they disagree, the run is incomplete and the headline is
  no longer weighting-independent.

## What "reproducible" means here

Case selection, ordering, and scoring are deterministic — see
[`docs/reproducibility.md`](reproducibility.md). The provider is a live service,
so its responses are not guaranteed identical across runs. Compare
distributions and intervals, not bytes.

## A smaller clone

The repository carries historical result bundles. `git clone --depth 1` gets you
a working tree without them.
