# Reproducibility

## What is deterministic

Case selection, case ordering, and scoring are fully deterministic. There is no
sampling, shuffling, or randomness anywhere in the runtime path — a test
(`test/determinism.test.mjs`) asserts that `Math.random()` appears nowhere in
`src/` outside the `src/testing/` fixtures. Given the same dataset and the same
configs, two runs enumerate exactly the same cases in exactly the same order,
and identical provider responses score identically.

## What is not

The provider is a live service. Its ranking can change when the underlying
corpus or index changes, and nothing in this harness can hold that fixed.

## What was observed

Two independent runs of the 8,850-row `trustfoundry-case-name-lookup/public-8850`
target against the live API, on different days, produced **identical results on
all 8,850 rows** — same `hit@1` verdict and same `hit_rank` on every row, and
therefore identical aggregates to four decimal places.

That is an observation, not a guarantee. It rests on one repeat, and a corpus or
index update will legitimately move rows. The honest claim is *no observed
nondeterminism*, not *nondeterminism is impossible*.

## What this means for comparing runs

Compare intervals, not bytes. Two bundles are comparable only when their
benchmark config, dataset, and scorer digests agree:

```bash
pnpm benchmark comparable <bundleA> <bundleB>
```

## Latency

Latency is client-inclusive by design — it is what a caller experiences, not a
server-side hotspot measurement. Always read it with its concurrency: every
published figure states its `--parallel` value, and a figure without one cannot
be compared to anything.
